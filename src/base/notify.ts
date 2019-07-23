import { emitter } from '@/base/events';

export const events = emitter<{ add: (notification: Notification) => void }>();

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationConfig {
  detail?: string;
  duration?: number;
  dismissible?: boolean;
}

export interface Notification {
  message: string;
  params: NotificationConfig;
  type: NotificationType;
  icon: string;
}

const notifications: Notification[] = [];

// TODO
// 'info-circle'
// 'check'
// 'exclamation-triangle'
// 'ban'

const notify = (type: NotificationType) => (message: string, params?: NotificationConfig) => {
  const notification = { message, params: params || {}, type, icon: 'info-circle' };
  notifications.push(notification);
  events.emit('add', notification);
};

export const info = notify('info');
export const success = notify('success');
export const warning = notify('warning');
export const error = notify('error');

export const subscribe = (listener: (notification: Notification) => void) => {
  notifications.forEach((notification) => {
    listener(notification);
  });

  events.addListener('add', listener);
  return {
    dispose() {
      events.removeListener('add', listener);
    },
  };
};