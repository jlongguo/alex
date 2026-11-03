// Client-only workspace routing. Never grants API authorization.
(() => {
  const views = Object.freeze({
    overview: {eyebrow:'HOME / OVERVIEW',title:'总览',description:'家庭状态、地图和快捷指令。'},
    tasks: {eyebrow:'HOME / AGENT TASKS',title:'Agent 与任务',description:'组合工作流、受限计划和家长审批。'},
    devices: {eyebrow:'HOME / ROBOTS',title:'设备与机器人',description:'虚拟设备配对、能力授权和导航状态。'},
    skills: {eyebrow:'HOME / SKILLS',title:'技能中心',description:'在当前身份授权范围内运行已安装技能。'},
    events: {eyebrow:'HOME / AUDIT',title:'事件与审计',description:'中枢事件与家长操作审计。'},
    family: {eyebrow:'HOME / FAMILY',title:'家庭与设置',description:'家长管理学习档案、记忆和隐私。'}
  });
  const links = [...document.querySelectorAll('[data-page-link]')];
  function activeView() {
    const requested = window.location.hash.slice(1);
    return Object.hasOwn(views, requested) ? requested : 'overview';
  }
  function renderNavigation() {
    const view = activeView();
    document.body.dataset.currentPage = view;
    document.getElementById('page-eyebrow').textContent = views[view].eyebrow;
    document.getElementById('page-title').textContent = views[view].title;
    document.getElementById('page-description').textContent = views[view].description;
    for (const link of links) {
      const selected = link.dataset.pageLink === view;
      link.classList.toggle('selected', selected);
      if (selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', () => {renderNavigation(); window.scrollTo(0,0);});
  for (const link of links) link.addEventListener('click', () => {
    if (window.location.hash === link.getAttribute('href')) renderNavigation();
  });
  renderNavigation();
})();
