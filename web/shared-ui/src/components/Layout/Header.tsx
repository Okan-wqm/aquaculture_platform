/**
 * Header Bileşeni
 * Uygulama üst çubuğu - Kullanıcı menüsü, bildirimler, arama
 */

import React, { useState, useRef, useEffect } from 'react';
import type { User, Tenant } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

/**
 * Tema türleri - Farklı roller için farklı renkler
 */
export type HeaderTheme = 'default' | 'admin' | 'tenant';

export interface HeaderProps {
  /** Giriş yapmış kullanıcı bilgileri */
  user?: User | null;
  /** Aktif tenant bilgileri */
  tenant?: Tenant | null;
  /** Arama işleyicisi */
  onSearch?: (query: string) => void;
  /** Bildirim sayısı */
  notificationCount?: number;
  /** Bildirimler tıklaması */
  onNotificationsClick?: () => void;
  /** Kullanıcı menüsü öğeleri */
  userMenuItems?: Array<{
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
  }>;
  /** Çıkış işleyicisi */
  onLogout?: () => void;
  /** Sol taraf öğeleri (opsiyonel) */
  leftContent?: React.ReactNode;
  /** Sağ taraf ek öğeler */
  rightContent?: React.ReactNode;
  /** Tema (admin=mor/indigo, tenant=yeşil/teal, default=mavi) */
  theme?: HeaderTheme;
  className?: string;
}

// ============================================================================
// Alt Bileşenler
// ============================================================================

/**
 * Arama kutusu
 */
const SearchBox: React.FC<{
  onSearch?: (query: string) => void;
}> = ({ onSearch }) => {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch?.(query);
  };

  return (
    <form onSubmit={handleSubmit} className="hidden md:flex items-center">
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <svg
            className="h-5 w-5 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ara... (Ctrl+K)"
          className="block w-64 pl-10 pr-4 py-2 border border-gray-300 rounded-lg bg-gray-50 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
    </form>
  );
};

/**
 * Bildirim butonu
 */
const NotificationButton: React.FC<{
  count?: number;
  onClick?: () => void;
}> = ({ count = 0, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
    aria-label={`Bildirimler ${count > 0 ? `(${count} yeni)` : ''}`}
  >
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
      />
    </svg>
    {count > 0 && (
      <span className="absolute top-1 right-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
        {count > 99 ? '99+' : count}
      </span>
    )}
  </button>
);

/**
 * Avatar renkleri tema bazlı
 */
const avatarColors = {
  default: 'bg-blue-600',
  admin: 'bg-indigo-600',
  tenant: 'bg-emerald-600',
};

/**
 * Kullanıcı avatar ve menüsü
 */
const UserMenu: React.FC<{
  user?: User | null;
  tenant?: Tenant | null;
  menuItems?: HeaderProps['userMenuItems'];
  onLogout?: () => void;
  theme?: HeaderTheme;
}> = ({ user, tenant, menuItems, onLogout, theme = 'default' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dışarı tıklama ile menüyü kapat
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!user) return null;

  // Initials - handle nullable firstName and lastName
  const getInitials = () => {
    const first = user.firstName?.[0] ?? '';
    const last = user.lastName?.[0] ?? '';
    if (first || last) return `${first}${last}`.toUpperCase();
    return user.email[0]?.toUpperCase() ?? '?';
  };
  const initials = getInitials();

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-3 p-2 rounded-lg hover:bg-gray-100 transition-colors"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        {/* Avatar - always show initials since User type doesn't have avatarUrl */}
        <div className={`w-8 h-8 rounded-full ${avatarColors[theme]} flex items-center justify-center`}>
          <span className="text-sm font-medium text-white">{initials}</span>
        </div>
        {/* İsim ve tenant */}
        <div className="hidden md:block text-left">
          <p className="text-sm font-medium text-gray-900">
            {user.firstName} {user.lastName}
          </p>
          {tenant && (
            <p className="text-xs text-gray-500">{tenant.name}</p>
          )}
        </div>
        {/* Chevron */}
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menü */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 rounded-lg bg-white shadow-lg ring-1 ring-black ring-opacity-5 z-50">
          {/* Kullanıcı bilgileri */}
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-medium text-gray-900">
              {user.firstName} {user.lastName}
            </p>
            <p className="text-sm text-gray-500 truncate">{user.email}</p>
          </div>

          {/* Menü öğeleri */}
          {menuItems && menuItems.length > 0 && (
            <div className="py-1">
              {menuItems.map((item, index) => (
                <button
                  key={index}
                  onClick={() => {
                    item.onClick();
                    setIsOpen(false);
                  }}
                  className={`
                    w-full flex items-center px-4 py-2 text-sm
                    ${item.danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-100'}
                  `}
                >
                  {item.icon && <span className="mr-3">{item.icon}</span>}
                  {item.label}
                </button>
              ))}
            </div>
          )}

          {/* Çıkış butonu */}
          {onLogout && (
            <div className="py-1 border-t border-gray-100">
              <button
                onClick={() => {
                  onLogout();
                  setIsOpen(false);
                }}
                className="w-full flex items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                <svg className="w-5 h-5 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
                Çıkış Yap
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Header Bileşeni
// ============================================================================

/**
 * Header bileşeni
 *
 * @example
 * <Header
 *   user={currentUser}
 *   tenant={currentTenant}
 *   onSearch={handleSearch}
 *   notificationCount={5}
 *   onNotificationsClick={() => openNotifications()}
 *   onLogout={handleLogout}
 * />
 */
/**
 * Header tema stilleri
 */
const headerThemeStyles = {
  default: {
    bg: 'bg-white',
    border: 'border-gray-200',
  },
  admin: {
    bg: 'bg-white',
    border: 'border-indigo-100',
  },
  tenant: {
    bg: 'bg-white',
    border: 'border-emerald-100',
  },
};

export const Header: React.FC<HeaderProps> = ({
  user,
  tenant,
  onSearch,
  notificationCount = 0,
  onNotificationsClick,
  userMenuItems,
  onLogout,
  leftContent,
  rightContent,
  theme = 'default',
  className = '',
}) => {
  const themeStyle = headerThemeStyles[theme];

  return (
    <header
      className={`
        sticky top-0 z-40
        ${themeStyle.bg} border-b ${themeStyle.border}
        ${className}
      `}
    >
      <div className="h-16 px-4 flex items-center justify-between">
        {/* Sol taraf */}
        <div className="flex items-center space-x-4">
          {leftContent}
        </div>

        {/* Orta - Arama */}
        <div className="flex-1 flex items-center justify-center px-4">
          {onSearch && <SearchBox onSearch={onSearch} />}
        </div>

        {/* Sağ taraf */}
        <div className="flex items-center space-x-2">
          {rightContent}

          {/* Bildirimler */}
          {onNotificationsClick && (
            <NotificationButton
              count={notificationCount}
              onClick={onNotificationsClick}
            />
          )}

          {/* Kullanıcı menüsü */}
          <UserMenu
            user={user}
            tenant={tenant}
            menuItems={userMenuItems}
            onLogout={onLogout}
            theme={theme}
          />
        </div>
      </div>
    </header>
  );
};

export default Header;
