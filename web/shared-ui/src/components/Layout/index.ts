/**
 * Layout bileşenleri dışa aktarımları
 */
export { Header, type HeaderProps } from './Header';
export { Sidebar, type SidebarProps } from './Sidebar';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export {
  PageTitle,
  PageTitleScope,
  usePageTitleMode,
  type PageTitleMode,
  type PageTitleProps,
  type PageTitleScopeProps,
} from './PageTitleScope';
export { DesktopOnlyNotice, type DesktopOnlyNoticeProps } from './DesktopOnlyNotice';
// Tenant console shell (Industry; design handoff phase 2): rail, workspace menu, header, annunciator, palette
export * from './console';
