import webpush from "web-push";
import { markNotification, readPendingNotifications, readPushSubscriptions, recordPushFailure } from "./persistence.js";

export async function deliverPendingNotifications(env) {
  const telegramEnabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (!telegramEnabled && !pushEnabled) return { enabled: false, delivered: 0 };
  const pending = await readPendingNotifications(env.DB);
  let delivered = 0;
  for (const notification of pending) {
    try {
      const incident = JSON.parse(notification.payload);
      if (telegramEnabled) await sendTelegram(env, formatTelegramMessage(notification.event_type, incident));
      if (pushEnabled) await sendWebPush(env, notification.event_type, incident);
      await markNotification(env.DB, notification.id, { delivered: true });
      delivered += 1;
    } catch (error) {
      await markNotification(env.DB, notification.id, {
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { enabled: true, telegramEnabled, pushEnabled, delivered };
}

export function formatTelegramMessage(eventType, incident) {
  const opened = eventType === "opened";
  const icon = opened ? "🚨" : "✅";
  const title = opened ? "Developer Control Center 告警" : "Developer Control Center 已恢复";
  return [
    `${icon} ${title}`,
    `节点: ${incident.host}`,
    `级别: ${incident.severity}`,
    `事件: ${incident.message}`,
    `时间: ${new Date(opened ? incident.openedAt : incident.resolvedAt).toISOString()}`,
  ].join("\n");
}

async function sendTelegram(env, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
}

async function sendWebPush(env, eventType, incident) {
  webpush.setVapidDetails(env.VAPID_SUBJECT || "mailto:you@example.com", env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const subscriptions = await readPushSubscriptions(env.DB);
  const payload = JSON.stringify({
    title: eventType === "opened" ? "Developer Control Center 告警" : "Developer Control Center 已恢复",
    body: `${incident.host} · ${incident.message}`,
    url: "/dashboard/#alerts-panel",
    tag: incident.alertKey,
  });
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, {
        TTL: 300,
        urgency: eventType === "opened" ? "high" : "normal",
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);
      await recordPushFailure(env.DB, subscription.endpoint_hash, { remove: statusCode === 404 || statusCode === 410 });
      if (statusCode !== 404 && statusCode !== 410) throw error;
    }
  }));
}
