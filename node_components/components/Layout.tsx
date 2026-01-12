import React from 'react';
import { Outlet }    from '@tanstack/react-router';
import Navbar        from './Navbar';
import AppSidebar    from './AppSidebar';
import Footer        from './Footer';
import styles        from './Layout.module.css';

export default function Layout() {
  return (
    <div className={styles.layout}>
      <Navbar />

      <div className={styles.main}>
        {/* forward a real `sidebar` class for our CSS selector */}
        <AppSidebar className="sidebar" />

        {/* forward a real `content` class so we can descend into it */}
        <div className={`${styles.content} content`}>
          <Outlet />  {/* renders ProcessPage at “/process” */}
        </div>
      </div>

      <Footer />
    </div>
  );
}
