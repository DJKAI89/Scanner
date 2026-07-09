import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

export default function TokenGate() {
  const { saveToken, tokenExpired } = useApp();
  const [value, setValue]   = useState('');
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  function handleLaunch() {
    setError('');
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 20) {
      setError('⚠ Token too short — paste the full Upstox access token');
      return;
    }
    setLoading(true);
    const err = saveToken(trimmed);
    if (err) { setError(err); setLoading(false); }
  }

  return (
    <div className="token-gate">
      <div className="tc" style={{ maxWidth: 460 }}>
        {/* Expired banner */}
        {tokenExpired && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
            padding: '10px 13px', marginBottom: 14, fontSize: 11, color: '#991b1b', fontWeight: 600,
          }}>
            ⚠ Token expired. Get a new one from Upstox Developer Portal.
          </div>
        )}

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div className="logo-ic" style={{ width: 42, height: 42, flexShrink: 0 }}>
            <span style={{ fontSize: 17 }}>F</span>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#0f172a' }}>Scanner</div>
            <div style={{ fontSize: 9, color: '#94a3b8', letterSpacing: '1.5px' }}>PROFESSIONAL NSE SCANNER</div>
          </div>
        </div>

        <h2 style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 12 }}>
          🔐 Enter Access Token
        </h2>

        {/* Instructions */}
        <div style={{
          background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
          padding: '11px 13px', marginBottom: 14, fontSize: 11, color: '#15803d', lineHeight: 1.8,
        }}>
          <strong>How to get your token (takes 30 seconds):</strong><br />
          1. Open{' '}
          <a href="https://developer.upstox.com" target="_blank" rel="noreferrer"
            style={{ color: '#15803d', fontWeight: 700, textDecoration: 'underline' }}>
            developer.upstox.com
          </a><br />
          2. Login → My Apps → your app<br />
          3. Click <strong>"Get Token"</strong> → Login with Upstox<br />
          4. Copy the Access Token → Paste below
        </div>

        <label style={{ fontSize: 10, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 5 }}>
          UPSTOX ACCESS TOKEN
        </label>

        <textarea
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleLaunch(); } }}
          placeholder="Paste your Upstox access token here..."
          style={{
            width: '100%', border: '1.5px solid #e2e8f0', borderRadius: 8,
            padding: '10px 12px', fontSize: 12, fontFamily: 'monospace',
            outline: 'none', resize: 'none', transition: '.15s',
          }}
          onFocus={(e) => { e.target.style.borderColor = '#16a34a'; e.target.style.boxShadow = '0 0 0 3px rgba(22,163,74,.1)'; }}
          onBlur={(e)  => { e.target.style.borderColor = '#e2e8f0'; e.target.style.boxShadow = 'none'; }}
        />

        {error && (
          <div style={{ color: '#dc2626', fontSize: 11, marginTop: 5 }}>{error}</div>
        )}

        <button
          className="btn btn-g"
          style={{ width: '100%', marginTop: 12, padding: 13, fontSize: 14, borderRadius: 9 }}
          onClick={handleLaunch}
          disabled={loading}
        >
          {loading ? '⏳ Launching...' : '▶ Launch Scanner'}
        </button>

        <div style={{ marginTop: 12, fontSize: 9, color: '#94a3b8', textAlign: 'center', lineHeight: 1.6 }}>
          Token is saved on this device · Expires daily · Paste fresh token each morning
        </div>
      </div>
    </div>
  );
}
