// ── Market time helpers (IST) ──

export function getIST() {
  return (
    new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }) + ' IST'
  );
}

export function getISTDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function localIsOpen() {
  const now = new Date();
  const istStr = now.toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = istStr.split(', ');
  const day = parts[0];
  const timeParts = (parts[1] || '00:00').split(':');
  const h = parseInt(timeParts[0], 10) % 24;
  const m = parseInt(timeParts[1], 10);
  if (day === 'Sat' || day === 'Sun') return false;
  const afterOpen  = h > 9 || (h === 9 && m >= 15);
  const beforeClose = h < 15 || (h === 15 && m <= 30);
  return afterOpen && beforeClose;
}

export function getMarketStatusLocal() {
  const open = localIsOpen();
  const now = new Date();
  const h = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
  const m = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: 'numeric' });
  const day = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  let msg = '';
  if (!open) {
    if (day === 'Sat' || day === 'Sun') msg = `📅 ${day} — NSE Closed`;
    else if (h < 9 || (h === 9 && m < 15)) msg = '⏰ Pre-market · NSE opens at 9:15 AM IST';
    else msg = '🔔 NSE Market Closed';
  }
  return { open, msg };
}

// ── Market phase detector (for signal quality adjustment) ──
// Returns: 'pre' | 'opening' | 'early' | 'midday' | 'pre_close' | 'closing' | 'closed' | 'holiday'
export function getMarketPhase() {
  const now = new Date();
  const h = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }) % 24;
  const m = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: 'numeric' });
  const day = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });

  // Weekend = holiday
  if (day === 'Sat' || day === 'Sun') return 'holiday';

  const t = h * 60 + m;
  
  // Pre-market: before 9:15 AM
  if (t < 9 * 60 + 15) return 'pre';
  
  // After market: after 3:30 PM (15:30)
  if (t > 15 * 60 + 30) return 'closed';
  
  // Within market hours (9:15 AM - 3:30 PM)
  if (t <= 9 * 60 + 45) return 'opening';      // 9:15-9:45: opening volatility
  if (t <= 10 * 60 + 30) return 'early';       // 9:45-10:30: early session
  if (t <= 14 * 60) return 'midday';           // 10:30-2:00 PM: most reliable for signals
  if (t <= 15 * 60) return 'pre_close';        // 2:00-3:00 PM: pre-close
  return 'closing';                             // 3:00-3:30 PM: closing noise
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
