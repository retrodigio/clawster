import { NavLink, Outlet } from 'react-router-dom';
import { List, Bot, Settings } from 'lucide-react';

const navItems = [
  { to: '/', label: 'Sessions', icon: List },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  return (
    <div className="flex h-full">
      <aside className="w-48 bg-terminal-surface border-r border-terminal-border flex flex-col shrink-0">
        <div className="px-4 py-4">
          <h1 className="text-base font-bold text-terminal-accent tracking-tight">Clawster</h1>
        </div>
        <nav className="flex flex-col gap-0.5 px-2 mt-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
                  isActive
                    ? 'text-terminal-fg bg-terminal-accent/10 border-l-2 border-terminal-accent'
                    : 'text-terminal-muted hover:text-terminal-fg border-l-2 border-transparent'
                }`
              }
            >
              <Icon size={14} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-4 py-3 text-[10px] text-terminal-muted">
          v0.3.0
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
