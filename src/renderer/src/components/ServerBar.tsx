/** Above the server terminal: opens the dev server's first listening port in the browser. */
export default function ServerBar({ ports }: { ports: number[] }): React.JSX.Element {
  const port = ports[0]
  return (
    <div className="server-bar">
      <button className="btn" data-testid="server-open" disabled={port === undefined}
        title={port === undefined ? 'Not listening on a port yet' : undefined}
        onClick={() => { if (port !== undefined) void window.pitwall.openExternal(`http://localhost:${port}`) }}>
        {port === undefined ? 'Open localhost' : `Open localhost:${port}`}
      </button>
    </div>
  )
}
