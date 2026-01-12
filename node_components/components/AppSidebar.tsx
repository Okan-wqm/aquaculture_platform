import React from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import HomeIcon from '@/assets/home.svg?component';
import ProcessIcon from '@/assets/process.svg?component';
import styles from './AppSidebar.module.css';

export default function Sidebar({ className }: { className?: string }) {
  const { state } = useRouter();
  const current = state.location.pathname;
  // merge the CSS-module class with any incoming className
  const cn = [styles.sidebar, className].filter(Boolean).join(' ');

  const items = [
    { id: 'dashboard', path: '/dashboard', icon: <HomeIcon />,    label: 'Dashboard' },
    { id: 'process',   path: '/process',   icon: <ProcessIcon />, label: 'Process'   },
  ];

  return (
    <aside className={cn}>
      <ul className={styles.menuList}>
        {items.map(({ id, path, icon, label }) => (
          <li key={id}>
            <Link
              to={path}
              className={styles.menuItem + (current === path ? ` ${styles.active}` : '')}
            >
              <span className={styles.icon}>{icon}</span>
              <span className={styles.label}>{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
