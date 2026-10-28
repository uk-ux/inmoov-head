// Independent eye states; hysteresis avoids chatter near the threshold.
export function createBlinkTracker(){
  const closed=[false,false],until=[0,0];
  return {
    reset(){closed.fill(false);until.fill(0);},
    update(left,right,time){
      return [left,right].reduce((mask,value,i)=>{
        const score=Number.isFinite(value)?value:0;
        if(!closed[i]&&score>=.25){closed[i]=true;until[i]=time+140;}
        else if(closed[i]&&score<=.12&&time>=until[i])closed[i]=false;
        return mask|(closed[i]?(1<<i):0);
      },0);
    }
  };
}
