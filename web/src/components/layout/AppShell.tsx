import {
  Activity,
  Archive,
  Database,
  FileClock,
  LogOut,
  Menu as MenuIcon,
  Moon,
  Network,
  ScrollText,
  Server,
  Settings,
  Sun,
  Table2,
  Terminal,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { Button, Select } from '../ui/basics.js'
import { logout } from '../../lib/api.js'
import { useConnection } from '../../lib/queries.js'
import { LANGUAGES, setLanguage, type LangCode } from '../../i18n/index.js'
import { useAuthStore } from '../../stores/auth.js'
import { useThemeStore } from '../../stores/theme.js'

export function AppShell() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const { theme, toggle } = useThemeStore()
  const match = useMatch('/c/:connId/*')
  const connId = match?.params.connId
  const connection = useConnection(connId)
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  // Keep the selected database when moving between workspace pages.
  const currentDb = new URLSearchParams(location.search).get('db')
  const dbSuffix = currentDb ? `?db=${encodeURIComponent(currentDb)}` : ''

  const workspaceNav = connId
    ? [
        { to: `/c/${connId}`, end: true, icon: Server, label: t('nav.overview') },
        { to: `/c/${connId}/explorer${dbSuffix}`, icon: Table2, label: t('nav.explorer') },
        { to: `/c/${connId}/sql${dbSuffix}`, icon: Terminal, label: t('nav.sql') },
        { to: `/c/${connId}/erd${dbSuffix}`, icon: Network, label: t('nav.erd') },
        { to: `/c/${connId}/monitor${dbSuffix}`, icon: Activity, label: t('nav.monitor') },
        { to: `/c/${connId}/roles`, icon: Users, label: t('nav.roles') },
        { to: `/c/${connId}/backups${dbSuffix}`, icon: Archive, label: t('nav.backups') },
      ]
    : []

  const platformNav = [
    { to: '/', end: true, icon: Database, label: t('nav.connections') },
    ...(user?.role === 'admin'
      ? [{ to: '/audit', end: false, icon: FileClock, label: t('nav.audit') }]
      : []),
    { to: '/settings', end: false, icon: Settings, label: t('nav.settings') },
  ]

  const doLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="shell">
      <aside className={`sidebar${mobileOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <span className="logo-mark">pg</span>
          pgforge
        </div>

        {connection && (
          <nav className="sidebar-section" aria-label={t('nav.workspace')}>
            <div className="sidebar-heading">
              <span
                className="conn-dot"
                style={{
                  display: 'inline-block',
                  marginRight: 6,
                  background: connection.color ?? 'var(--accent)',
                }}
              />
              {connection.name}
            </div>
            {workspaceNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                onClick={() => setMobileOpen(false)}
              >
                <item.icon size={15} strokeWidth={1.8} />
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}

        <nav className="sidebar-section" aria-label={t('nav.platform')}>
          <div className="sidebar-heading">{t('nav.platform')}</div>
          {platformNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              onClick={() => setMobileOpen(false)}
            >
              <item.icon size={15} strokeWidth={1.8} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="row" style={{ padding: '4px 8px' }}>
            <ScrollText size={14} className="faint" />
            <span className="truncate grow" style={{ fontSize: 'var(--text-sm)' }}>
              {user?.name}
            </span>
            <span className="badge badge-muted">{user?.role}</span>
          </div>
          <div className="row" style={{ padding: '2px 8px 4px' }}>
            <Select
              value={i18n.language}
              onChange={(e) => setLanguage(e.target.value as LangCode)}
              style={{ height: 26, fontSize: 'var(--text-xs)' }}
              aria-label={t('common.language')}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              icon={theme === 'dark' ? Sun : Moon}
              onClick={toggle}
              aria-label={t('common.theme')}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={LogOut}
              onClick={() => void doLogout()}
              aria-label={t('auth.logout')}
            />
          </div>
        </div>
      </aside>

      <div className="main">
        <Button
          variant="ghost"
          icon={MenuIcon}
          onClick={() => setMobileOpen((v) => !v)}
          style={{ position: 'fixed', top: 7, left: 8, zIndex: 95, display: 'none' }}
          className="mobile-menu-btn"
          aria-label="Menu"
        />
        <Outlet />
      </div>
    </div>
  )
}
