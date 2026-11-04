const base = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const }

export const PlusIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M8 3.5v9M3.5 8h9" /></svg>
)
export const DotsIcon = (): React.JSX.Element => (
  <svg {...base} fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" /></svg>
)
export const FolderIcon = (): React.JSX.Element => (
  <svg {...base} className="folder-icon" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></svg>
)
export const FolderPlusIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M8 7.5v3M6.5 9h3" /></svg>
)
export const MutedBellIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M4 11.5h8l-1-1.5V7a3 3 0 0 0-6 0v3zM6.8 13.2a1.3 1.3 0 0 0 2.4 0M2.5 2.5l11 11" /></svg>
)
export const FileIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M4 2.5h4.8L12 5.7V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13z" /><path d="M8.8 2.5v3.2H12" /></svg>
)
export const HistoryIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M2.8 2.6v2.3h2.3" /><path d="M8 5.3V8l1.8 1.2" /></svg>
)
export const ChevronIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M6.5 4.5 10 8l-3.5 3.5" /></svg>
)

// ---- session status: each its own shape, so it reads without knowing the colours ----
export const HandIcon = (): React.JSX.Element => (
  <svg {...base} strokeLinejoin="round"><path d="M6 8.5V3.8a1 1 0 0 1 2 0v3.7M8 7.5V3a1 1 0 0 1 2 0v4.5M10 7.5V4.3a1 1 0 0 1 2 0V10c0 2.2-1.7 4-4 4-1.5 0-2.5-.6-3.4-1.8L3 10a1 1 0 0 1 1.5-1.3L6 10.2V8.5" /></svg>
)
export const SpinnerIcon = (): React.JSX.Element => (
  <svg {...base}><circle cx="8" cy="8" r="5.5" strokeOpacity=".25" /><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" /></svg>
)
export const CheckCircleIcon = (): React.JSX.Element => (
  <svg {...base} strokeLinejoin="round"><circle cx="8" cy="8" r="6" /><path d="M5.4 8.3l1.8 1.8 3.4-3.8" /></svg>
)
export const WarningIcon = (): React.JSX.Element => (
  <svg {...base} strokeLinejoin="round"><path d="M8 2.5 14 13.2H2z" /><path d="M8 6.6v3" /><circle cx="8" cy="11.4" r=".45" fill="currentColor" /></svg>
)
export const StoppedIcon = (): React.JSX.Element => (
  <svg {...base}><circle cx="8" cy="8" r="6" /><rect x="6" y="6" width="4" height="4" rx=".6" fill="currentColor" stroke="none" /></svg>
)
export const StartingIcon = (): React.JSX.Element => (
  <svg {...base}><circle cx="8" cy="8" r="5.5" strokeDasharray="1.6 2.6" /></svg>
)

// ---- pull requests ----
const prBase = <><circle cx="4.5" cy="3.8" r="1.6" /><circle cx="4.5" cy="12.2" r="1.6" /><path d="M4.5 5.4v5.2" /></>
export const PrOpenIcon = (): React.JSX.Element => (
  <svg {...base} strokeLinejoin="round">{prBase}<circle cx="11.5" cy="12.2" r="1.6" /><path d="M11.5 10.6V6.3a1.5 1.5 0 0 0-1.5-1.5H7.6M9.2 3.2 7.6 4.8l1.6 1.6" /></svg>
)
export const PrDraftIcon = (): React.JSX.Element => (
  <svg {...base}>{prBase}<circle cx="11.5" cy="12.2" r="1.6" /><path d="M11.5 3.4v.8M11.5 6.1v.8M11.5 8.8v.8" /></svg>
)
export const PrMergedIcon = (): React.JSX.Element => (
  <svg {...base}>{prBase}<circle cx="11.5" cy="9" r="1.6" /><path d="M4.5 5.4c0 2.2 1.8 3.6 5.4 3.6" /></svg>
)
export const PrClosedIcon = (): React.JSX.Element => (
  <svg {...base}>{prBase}<circle cx="11.5" cy="12.2" r="1.6" /><path d="M11.5 10.6V7.6M10 2.8l3 3M13 2.8l-3 3" /></svg>
)
export const CheckMarkIcon = (): React.JSX.Element => (
  <svg {...base} strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
)
export const CrossMarkIcon = (): React.JSX.Element => (
  <svg {...base}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
)
export const PendingMarkIcon = (): React.JSX.Element => (
  <svg {...base}><circle cx="8" cy="8" r="4" /></svg>
)
