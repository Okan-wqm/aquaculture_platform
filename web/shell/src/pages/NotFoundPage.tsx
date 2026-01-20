/**
 * Not Found / Error Sayfası
 *
 * 404 ve yetkilendirme hatası sayfaları.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@aquaculture/shared-ui';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface NotFoundPageProps {
  /** Hata tipi */
  type?: 'notfound' | 'unauthorized' | 'error';
}

// ============================================================================
// İçerik Yapılandırması
// ============================================================================

const pageContent = {
  notfound: {
    code: '404',
    title: 'Sayfa Bulunamadı',
    description: 'Aradığınız sayfa mevcut değil veya taşınmış olabilir.',
    icon: (
      <svg className="w-24 h-24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1}
          d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
  unauthorized: {
    code: '403',
    title: 'Erişim Reddedildi',
    description: 'Bu sayfaya erişim yetkiniz bulunmamaktadır.',
    icon: (
      <svg className="w-24 h-24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1}
          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
        />
      </svg>
    ),
  },
  error: {
    code: '500',
    title: 'Sunucu Hatası',
    description: 'Beklenmeyen bir hata oluştu. Lütfen daha sonra tekrar deneyin.',
    icon: (
      <svg className="w-24 h-24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
    ),
  },
};

// ============================================================================
// Ana Bileşen
// ============================================================================

const NotFoundPage: React.FC<NotFoundPageProps> = ({ type = 'notfound' }) => {
  const content = pageContent[type];

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="text-center max-w-md">
        {/* İkon */}
        <div className="text-gray-300 mb-6 flex justify-center">{content.icon}</div>

        {/* Hata Kodu */}
        <div className="text-6xl font-bold text-gray-200 mb-4">{content.code}</div>

        {/* Başlık */}
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{content.title}</h1>

        {/* Açıklama */}
        <p className="text-gray-600 mb-8">{content.description}</p>

        {/* Aksiyon Butonları */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link to="/">
            <Button variant="primary">Ana Sayfaya Dön</Button>
          </Link>
          <Button variant="outline" onClick={() => window.history.back()}>
            Geri Git
          </Button>
        </div>

        {/* Yardım Linki */}
        <p className="mt-8 text-sm text-gray-500">
          Sorun devam ederse{' '}
          <a href="/support" className="text-primary-600 hover:text-primary-700 font-medium">
            destek ekibimizle
          </a>{' '}
          iletişime geçin.
        </p>
      </div>
    </div>
  );
};

export default NotFoundPage;
