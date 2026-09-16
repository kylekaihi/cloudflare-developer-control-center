export function formatClock(date = new Date()) {
  const datePart = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(date);

  const timePart = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

  return `${datePart} ${timePart}`;
}

export function renderSiteStats({
  clockElement,
  now = () => new Date(),
  intervalMs = 1000,
} = {}) {
  const updateClock = () => {
    const currentTime = now();
    if (clockElement) {
      clockElement.textContent = formatClock(currentTime);
      clockElement.setAttribute?.("datetime", currentTime.toISOString());
    }
  };

  updateClock();
  if (intervalMs > 0) {
    globalThis.setInterval(updateClock, intervalMs);
  }
}

export function startSiteStats() {
  return renderSiteStats({
    clockElement: document.querySelector("[data-current-time]"),
  });
}

if (typeof document !== "undefined") {
  startSiteStats();
}
