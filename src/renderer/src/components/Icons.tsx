const base = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const }

export const PlusIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M8 3.5v9M3.5 8h9" /></svg>
)
export const DotsIcon = (): React.JSX.Element => (
  <svg {...base} fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" /></svg>
)
export const FolderPlusIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M8 7.5v3M6.5 9h3" /></svg>
)
export const MutedBellIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M4 11.5h8l-1-1.5V7a3 3 0 0 0-6 0v3zM6.8 13.2a1.3 1.3 0 0 0 2.4 0M2.5 2.5l11 11" /></svg>
)
