// Moteur de recommandation v1 : règles + scores pondérés, entièrement explicables.
// Aucune donnée sensible (genre, origine, région d'origine) n'entre dans le calcul.
export const DIMS = ['R', 'I', 'A', 'S', 'E', 'C'];

/** Profil RIASEC (0–100 par dimension) + scores de matières (0–1) + contraintes, à partir des réponses. */
export function computeProfile(questions, answers) {
  const raw = Object.fromEntries(DIMS.map(d => [d, 0]));
  const max = Object.fromEntries(DIMS.map(d => [d, 0]));
  const subj = {}, subjMax = {};
  const constraints = {};
  const addSubj = (k, v, m) => { subj[k] = (subj[k] || 0) + v; subjMax[k] = (subjMax[k] || 0) + m; };

  for (const q of questions) {
    const a = answers[q.id];
    if (q.type === 'scale') {
      for (const [d, w] of Object.entries(q.dims || {})) { max[d] += w; if (a != null) raw[d] += ((+a - 1) / 4) * w; }
      if (q.subject) addSubj(q.subject, a != null ? (+a - 1) / 4 : 0, 1);
    } else if (q.type === 'choice' || q.type === 'multi') {
      const k = q.type === 'multi' ? (q.max || 1) : 1;
      for (const d of DIMS) {
        const vals = q.options.map(o => o.dims?.[d] || 0).sort((x, y) => y - x);
        max[d] += vals.slice(0, k).reduce((s, v) => s + v, 0);
      }
      const picked = [].concat(a ?? []);
      for (const o of q.options) if (picked.includes(o.v)) for (const [d, w] of Object.entries(o.dims || {})) raw[d] += w;
    } else if (q.type === 'rank') {
      const order = Array.isArray(a) ? a : q.options.map(o => o.v);
      const n = order.length;
      order.forEach((v, i) => addSubj(v, (n - 1 - i) / (n - 1), 1));
    } else if (q.type === 'constraint' && a != null) {
      constraints[q.key] = a;
    }
  }
  const riasec = Object.fromEntries(DIMS.map(d => [d, max[d] ? Math.round((raw[d] / max[d]) * 100) : 0]));
  const subjects = Object.fromEntries(Object.keys(subj).map(k => [k, +(subj[k] / subjMax[k]).toFixed(2)]));
  const code = [...DIMS].sort((a, b) => riasec[b] - riasec[a]).slice(0, 3).join('');
  return { riasec, subjects, constraints, code };
}

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
function pearson(a, b) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Recommandations classées.
 * @returns {{programs: Array<{id, score, reasons, universities}>}}
 * Les raisons sont structurées ({k, p}) pour être traduites côté client.
 */
export function recommend({ profile, userProfile = {}, programs, universities, weights }) {
  const w = weights;
  const { riasec, subjects, constraints } = profile;
  const bac = userProfile.bac, avg = userProfile.average != null && userProfile.average !== '' ? +userProfile.average : null;
  const city = (userProfile.city || '').trim().toLowerCase();
  const budget = constraints.budget != null ? +constraints.budget : (userProfile.budget != null && userProfile.budget !== '' ? +userProfile.budget : -1);
  const maxDur = constraints.duration != null ? +constraints.duration : 99;
  const typePref = constraints.type || userProfile.typePref || 'any';
  const mobility = constraints.mobility || 'any';

  const out = programs.map(pg => {
    const reasons = [];
    // 1) Intérêts : moyenne des scores de l'étudiant pondérée par le profil de la filière
    let num = 0, den = 0;
    for (const d of DIMS) { num += (riasec[d] / 100) * (pg.riasec[d] || 0); den += pg.riasec[d] || 0; }
    const level = den ? num / den : 0;               // niveau : l'étudiant aime-t-il ce que la filière demande ?
    const interest = 0.5 * level + 0.5 * (pearson(DIMS.map(d => riasec[d]), DIMS.map(d => pg.riasec[d] || 0)) + 1) / 2; // + forme du profil
    const topDims = DIMS.filter(d => (pg.riasec[d] || 0) >= 0.7).sort((a, b) => riasec[b] - riasec[a]);
    for (const d of topDims.slice(0, 2)) reasons.push({ k: riasec[d] >= 60 ? 'dimMatch' : 'dimWeak', p: { dim: d, v: riasec[d] }, good: riasec[d] >= 60 });

    // 2) Parcours scolaire
    let academic = 0.7;
    if (bac || avg != null) {
      const seriesOk = !bac || pg.series.includes(bac);
      const avgScore = avg == null ? 0.7 : clamp(1 - Math.max(0, pg.minAvg - avg) / 4);
      academic = 0.5 * (seriesOk ? 1 : 0.2) + 0.5 * avgScore;
      if (bac) reasons.push(seriesOk ? { k: 'bacOk', p: { bac }, good: true } : { k: 'bacKo', p: { bac }, good: false });
      if (avg != null) reasons.push(avg >= pg.minAvg ? { k: 'avgOk', p: { min: pg.minAvg }, good: true } : { k: 'avgKo', p: { min: pg.minAvg, avg }, good: false });
    } else reasons.push({ k: 'noAcademic', good: null });

    // 3) Matières préférées / aptitudes
    const sv = pg.subjects.map(s => subjects[s]).filter(v => v != null);
    const subjScore = sv.length ? sv.reduce((a, b) => a + b, 0) / sv.length : 0.5;
    const likedSubjects = pg.subjects.filter(s => (subjects[s] ?? 0) >= 0.65);
    if (likedSubjects.length) reasons.push({ k: 'subjects', p: { list: likedSubjects }, good: true });

    const wsum = w.interest + w.academic + w.subjects || 1;
    let score = (w.interest * interest + w.academic * academic + w.subjects * subjScore) / wsum;
    if (pg.duration > maxDur) { score *= w.penaltyDuration; reasons.push({ k: 'durationLong', p: { years: pg.duration }, good: false }); }

    // Universités proposant la filière, ajustées aux contraintes
    const unis = universities.filter(u => u.programs?.includes(pg.id)).map(u => {
      let f = 1; const notes = [];
      if (mobility === 'city' && city && u.city.toLowerCase() !== city) { f *= w.penaltyCity; notes.push('otherCity'); }
      if (budget >= 0 && u.fees > budget) { f *= w.penaltyBudget; notes.push('overBudget'); }
      if (typePref !== 'any' && u.type !== typePref) { f *= w.penaltyType; notes.push('typeMismatch'); }
      if (city && u.city.toLowerCase() === city) notes.push('inCity');
      return { id: u.id, fit: Math.round(score * f * 100), notes };
    }).sort((a, b) => b.fit - a.fit);
    if (unis.length && unis[0].fit < score * 100 - 0.5) reasons.push({ k: 'constraintsHit', good: false });

    return { id: pg.id, score: Math.round(score * 100), parts: { interest: Math.round(interest * 100), academic: Math.round(academic * 100), subjects: Math.round(subjScore * 100) }, reasons, universities: unis };
  }).sort((a, b) => b.score - a.score);

  return { programs: out };
}
