// Map expression scores to the calibrated UI scale (not physical degrees).
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const score=(shapes,key)=>Number.isFinite(shapes[key])?clamp(shapes[key],0,1):0;
const response=(v,deadband,full)=>clamp((v-deadband)/(full-deadband),0,1);
export function mouthTargets(shapes){
  const jaw=180*response(score(shapes,'jawOpen'),.04,.65);
  const cheek=side=>{
    const lift=Math.max(score(shapes,'mouthSmile'+side),score(shapes,'cheekSquint'+side));
    const lower=score(shapes,'mouthFrown'+side);
    return clamp(90+90*(response(lift,.06,.65)-response(lower,.06,.65)),0,180);
  };
  return [jaw,cheek('Left'),cheek('Right')];
}
