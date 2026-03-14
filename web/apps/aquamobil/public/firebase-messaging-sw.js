/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: self.__FIREBASE_CONFIG__?.apiKey,
  projectId: self.__FIREBASE_CONFIG__?.projectId,
  messagingSenderId: self.__FIREBASE_CONFIG__?.messagingSenderId,
  appId: self.__FIREBASE_CONFIG__?.appId,
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'Notification', {
    body: body || 'You have a new notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: payload.data,
  });
});
