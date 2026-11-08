import React from 'react';

export default function TapeFeed({ events }) {
  if (!events.length) {
    return <div className="empty-state">Tape is quiet. Orders, exits, halts and fresh signals will print here.</div>;
  }
  return (
    <div className="tape-feed">
      {events.map(e => (
        <div key={e.id} className="tape-event">
          <span className="tape-time">{new Date(e.ts).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</span>
          <span className={`tape-tone ${e.tone || ''}`} />
          <span className="tape-text">{e.text}</span>
        </div>
      ))}
    </div>
  );
}
