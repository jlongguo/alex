// Deterministic, transparent text-only conversation Skills. Not an LLM or ASR.
// Kept independent from RobotRuntime and device commands by design.
export const COMPANION_MODES = Object.freeze(['chat','english','story','quiz']);

export function opening(mode, hasModel=false) {
  if(mode==='english') return hasModel
    ? 'Hello! I am Alex. We can practice easy English. What would you like to talk about?'
    : 'Hello! I am Alex. Let us practice easy English. What nickname should I call you?';
  if(mode==='story') return hasModel
    ? '我们来一起创作一个安全有趣的故事。你想让主角是谁？'
    : '你来到一座会发光的图书馆。A：打开星星地图。B：跟着会说话的小猫。请选择 A 或 B。';
  if(mode==='quiz')return hasModel
    ? '来一起讨论一些日常科学小问题吧！'
    : '科学小问答！第 1 题：植物生长最需要哪一种光？A：阳光  B：月光。请选择 A 或 B。';
  if(mode==='chat') return hasModel
    ? '你好，我是 Alex。你可以和我对话；我不会在聊天中自动控制设备。'
    : '自由对话尚未启用模型。请家长配置 ALEX_CHAT_PROVIDER=compatible；现在可以使用离线英语和互动故事。';
  throw new Error('INVALID_COMPANION_MODE');
}

const safe = text => String(text).replace(/[\r\n\t]/g,' ').trim().slice(0,50);
const yesNo = text => /^(a|b|选a|选b|左|右|左边|右边)$/i.test(text.trim());

export function offlineReply(mode, input, step=0, context='') {
  const value = input.trim();
  if(mode==='chat') throw new Error('CHAT_MODEL_REQUIRED');
  if(mode==='english') {
    // One short question per step; simple text-pattern coaching, NOT a
    // pronunciation assessment and NOT a general language understanding model.
    if(step===0) {
      if(value.length<1) return {step,context,text:'Please tell me a nickname. You may use any made-up name.'};
      return {step:1,context:safe(value),text:'Nice to meet you, '+safe(value)+'! What food do you like? Try: I like apples.'};
    }
    if(step===1) {
      if(!/\bi like\s+[\w ]{2,40}[.!?]?$/i.test(value))
        return {step,context,text:'Good try! Can you say a full sentence? For example: I like apples.'};
      return {step:2,context,text:'Great sentence! What color do you like? Try: I like blue.'};
    }
    if(step===2) {
      if(!/\bi like\s+[\w ]{2,40}[.!?]?$/i.test(value))
        return {step,context,text:'Let us practice: I like blue. Now you try with your favorite color.'};
      return {step:3,context,text:'Well done! What can you do? Try: I can swim.'};
    }
    if(step===3) {
      if(!/\bi can\s+[\w ]{2,40}[.!?]?$/i.test(value))
        return {step,context,text:'Almost! Use: I can + an action. For example: I can dance.'};
      return {step:4,context,text:'Nice work! Last question: How are you today? Try: I am happy.'};
    }
    if(step===4) {
      if(!/\bi (?:am|'m)\s+[\w ]{2,40}[.!?]?$/i.test(value))
        return {step,context,text:'Try a full answer: I am happy. Or: I am tired.'};
      return {step:5,context,text:'Great job! Today we practiced: My nickname is..., I like..., I can..., and I am.... Reply “restart” to practice again.'};
    }
    if(/^(restart|again|重新开始|再来一次)$/i.test(value))
      return {step:0,context:'',text:opening('english')};
    return {step,context,text:'Our five-step text practice is complete. Reply “restart” to practice again.'};
  }
  if(mode==='story') {
    if(step>=3) {
      if(/^(restart|again|重新开始|再来一次)$/i.test(value))
        return {step:0,context:'',text:opening('story')};
      return {step,context,text:'故事已经结束啦。输入“重新开始”再探险一次！'};
    }
    if(!yesNo(value))return {step,context,text:'请选择 A 或 B；你也可以输入“左”或“右”。'};
    const choice=/^(a|选a|左|左边)$/i.test(value)?'A':'B';
    const trail=context+choice;
    if(step===0) return {step:1,context:trail,text:choice==='A'
      ?'你在星星地图上看到一座小桥。A：先观察桥是否安全。B：向猫咪问路。'
      :'猫咪说森林里有遗失的歌声。A：一起寻找歌声。B：先给猫咪取个名字。'};
    if(step===1) return {step:2,context:trail,text:choice==='A'
      ?'你发现一盏温柔的萤火灯，照亮了回家的路。A：把灯放回书架。B：和朋友分享灯光。'
      :'你和朋友互相帮助，找到了图书馆的出口。A：感谢朋友。B：把今天的冒险画下来。'};
    return {step:3,context:trail,text:'你做出了选择 '+trail.split('').join(' → ')+'。故事圆满结束：好奇心和互相帮助让今天变得特别。输入“重新开始”再讲一个。'};
  }
  throw new Error('INVALID_COMPANION_MODE');
}
