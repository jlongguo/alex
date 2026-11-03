// Sidebar workspace navigation. This only changes the view, never authentication or privileges.
(() => {
  const views = Object.freeze({
    overview: {eyebrow: 'HOME / CONTROL CENTER', title: '指挥中心', description: '一个大脑，多个技能，一台正在成长的机器人。'},
    devices: {eyebrow: 'HOME / DEVICES', title: '设备管理', description: '管理已授权的虚拟设备、能力与任务。'},
    skills: {eyebrow: 'HOME / SKILLS', title: '技能中心', description: '查看已注册技能，并在当前身份许可范围内启动。'},
    events: {eyebrow: 'HOME / EVENTS', title: '事件与日志', description: '查看中枢的实时事件和任务反馈。'}
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
  // Native links support keyboard navigation, deep links and browser back/forward.
  window.addEventListener('hashchange', () => {
    renderNavigation();
    window.scrollTo(0, 0);
  });
  for (const link of links) {
    link.addEventListener('click', () => {
      // Hashchange does not fire when the user clicks the active link again.
      if (window.location.hash === link.getAttribute('href')) renderNavigation();
    });
  }
  renderNavigation();
})();
