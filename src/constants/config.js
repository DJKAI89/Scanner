// ── App-wide constants ──

export const CFG_VERSION = 'v4'; // match HTML exactly — bump to reset all users

// ── Default config — exact copy from HTML DEF ──
// Key calibrated values:
//   delta:      0.40  (only near-ATM options)
//   oi:         15    (5% OI change is noise; 15%+ = meaningful)
//   minOptConf: 65    (historical: 65% conf still 7% win rate; 65+ is cleaner)
export const DEF = {
  minStockConf: 50,
  pot:          3,
  risk:         55,
  rr:           1.2,
  rsiOS:        35,
  rsiOB:        65,
  vol:          1.2,
  delta:        0.40,
  iv:           15,
  oi:           15,
  optSL:        25,
  optTgt:       50,
  minOptConf:   65,
  maxOptCapital: 0,
  portSize:     500000,
  riskPct:      2,
};

export const INDEX_OPTS = [
  { key: 'NSE_INDEX|Nifty 50',          name: 'NIFTY',     step: 50,  lot: 75  },
  { key: 'NSE_INDEX|Nifty Bank',         name: 'BANKNIFTY', step: 100, lot: 30  },
  { key: 'BSE_INDEX|SENSEX',             name: 'SENSEX',    step: 100, lot: 20  },
  { key: 'NSE_INDEX|Nifty Fin Service',  name: 'FINNIFTY',  step: 50,  lot: 65  },
];

export const TABS = [
  { id: 'stocks',    icon: '📈', label: 'Stocks',        pageLabel: '📈 Stocks'      },
  { id: 'options',   icon: '⚡', label: 'F&O Options',   pageLabel: '⚡ F&O Options' },
  { id: 'portfolio', icon: '💼', label: 'Portfolio',     pageLabel: '💼 Portfolio'   },
  { id: 'lookup',    icon: '🔍', label: 'Analyse Stock', pageLabel: '🔍 Analyse Stock'     },
  { id: 'log',       icon: '📋', label: 'Signal Log',    pageLabel: '📋 Signal Log'  },
  { id: 'analysis',  icon: '📊', label: 'Analysis Signal Log',      pageLabel: '📊 Analysis Signal Log'    },
  { id: 'settings',  icon: '⚙',  label: 'Settings',      pageLabel: '⚙ Settings'    },
];

export const QUICK_STOCKS = [
  'RELIANCE','HDFCBANK','INFY','TCS','SBIN',
  'TATAMOTORS','BAJFINANCE','ICICIBANK','ICICIAMC','ITC',
];

export const THROTTLE_MS = 420;

export const TOP_FO_SYMBOLS = ['RELIANCE','TCS','HDFCBANK','ICICIBANK','INFY','SBIN','AXISBANK','BAJFINANCE','WIPRO','KOTAKBANK','ITC','LT','TATAMOTORS','ADANIENT','MARUTI'];

export const SECTOR_CTX_MAP = {
  HDFCBANK:'BANKNIFTY', ICICIBANK:'BANKNIFTY', KOTAKBANK:'BANKNIFTY', AXISBANK:'BANKNIFTY',
  SBIN:'BANKNIFTY', IDFCFIRSTB:'BANKNIFTY', BANDHANBNK:'BANKNIFTY', RBLBANK:'BANKNIFTY',
  FEDERALBNK:'BANKNIFTY', INDIANB:'BANKNIFTY', BANKINDIA:'BANKNIFTY', BANKBARODA:'BANKNIFTY',
  CANBK:'BANKNIFTY', PNB:'BANKNIFTY', UNIONBANK:'BANKNIFTY', INDUSINDBK:'BANKNIFTY',
};

// Weekly expiry day detection — NSE: Thu (NIFTY), Wed (BANKNIFTY)
export function isWeeklyExpiryDay() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone:'Asia/Kolkata' }));
  return d.getDay() === 4 || d.getDay() === 3; // Thu=4, Wed=3
}

// Time-of-day penalty (same as HTML getTimeOfDayPenalty)
export function getTimeOfDayPenalty() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone:'Asia/Kolkata' }));
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins >= 555 && mins <= 585) return +5;   // 9:15-9:45 opening
  if (mins >= 585 && mins <= 660) return  0;   // 9:45-11:00 ideal
  if (mins >= 660 && mins <= 810) return -5;   // 11:00-13:30 mid
  if (mins >= 810 && mins <= 870) return -12;  // 13:30-14:30 afternoon
  if (mins >= 870)                return -18;  // 14:30+ pre-close
  return 0;
}

// ── Fallback Nifty 50 stock list (used when stocks.json not loaded from GitHub) ──
export const NIFTY50_FALLBACK = [
  { key:'NSE_EQ|INE040A01034', s:'HDFCBANK',   n:'HDFC Bank',              sec:'Banking',  fo:true,  lot:550,  step:50  },
  { key:'NSE_EQ|INE002A01018', s:'RELIANCE',   n:'Reliance Industries',    sec:'Energy',   fo:true,  lot:250,  step:50  },
  { key:'NSE_EQ|INE467B01029', s:'TCS',        n:'Tata Consultancy',       sec:'IT',       fo:true,  lot:175,  step:50  },
  { key:'NSE_EQ|INE009A01021', s:'INFY',       n:'Infosys',                sec:'IT',       fo:true,  lot:400,  step:50  },
  { key:'NSE_EQ|INE062A01020', s:'SBIN',       n:'State Bank of India',    sec:'Banking',  fo:true,  lot:1500, step:10  },
  { key:'NSE_EQ|INE030A01027', s:'ICICIBANK',  n:'ICICI Bank',             sec:'Banking',  fo:true,  lot:700,  step:50  },
  { key:'NSE_EQ|INE296A01024', s:'BAJFINANCE', n:'Bajaj Finance',          sec:'Finance',  fo:true,  lot:125,  step:100 },
  { key:'NSE_EQ|INE154A01025', s:'ITC',        n:'ITC Limited',            sec:'FMCG',     fo:true,  lot:1600, step:5   },
  { key:'NSE_EQ|INE585B01010', s:'AXISBANK',   n:'Axis Bank',              sec:'Banking',  fo:true,  lot:625,  step:50  },
  { key:'NSE_EQ|INE347G01014', s:'KOTAKBANK',  n:'Kotak Mahindra Bank',    sec:'Banking',  fo:true,  lot:400,  step:100 },
  { key:'NSE_EQ|INE522F01014', s:'LT',         n:'Larsen & Toubro',        sec:'Infra',    fo:true,  lot:150,  step:100 },
  { key:'NSE_EQ|INE257A01026', s:'WIPRO',      n:'Wipro',                  sec:'IT',       fo:true,  lot:1500, step:10  },
  { key:'NSE_EQ|INE070A01015', s:'HCLTECH',    n:'HCL Technologies',       sec:'IT',       fo:true,  lot:700,  step:50  },
  { key:'NSE_EQ|INE018A01030', s:'MARUTI',     n:'Maruti Suzuki',          sec:'Auto',     fo:true,  lot:100,  step:100 },
  { key:'NSE_EQ|INE721A01013', s:'ULTRACEMCO', n:'UltraTech Cement',       sec:'Cement',   fo:true,  lot:100,  step:100 },
  { key:'NSE_EQ|INE262H01021', s:'ADANIENT',   n:'Adani Enterprises',      sec:'Conglom',  fo:true,  lot:125,  step:100 },
  { key:'NSE_EQ|INE101A01026', s:'HINDUNILVR', n:'Hindustan Unilever',     sec:'FMCG',     fo:true,  lot:300,  step:50  },
  { key:'NSE_EQ|INE397D01024', s:'ASIANPAINT', n:'Asian Paints',           sec:'Paints',   fo:true,  lot:200,  step:50  },
  { key:'NSE_EQ|INE066A01021', s:'POWERGRID',  n:'Power Grid Corp',        sec:'Utilities',fo:true,  lot:2700, step:5   },
  { key:'NSE_EQ|INE020B01018', s:'NESTLEIND',  n:'Nestle India',           sec:'FMCG',     fo:true,  lot:50,   step:100 },
  { key:'NSE_EQ|INE117A01022', s:'BAJAJFINSV', n:'Bajaj Finserv',          sec:'Finance',  fo:true,  lot:500,  step:100 },
  { key:'NSE_EQ|INE742F01042', s:'TATAMOTORS', n:'Tata Motors',            sec:'Auto',     fo:true,  lot:1425, step:5   },
  { key:'NSE_EQ|INE081A01020', s:'TATASTEEL',  n:'Tata Steel',             sec:'Metals',   fo:true,  lot:5500, step:5   },
  { key:'NSE_EQ|INE176A01028', s:'ONGC',       n:'ONGC',                   sec:'Energy',   fo:true,  lot:1925, step:5   },
  { key:'NSE_EQ|INE628A01036', s:'NTPC',       n:'NTPC',                   sec:'Utilities',fo:true,  lot:2250, step:5   },
  { key:'NSE_EQ|INE883A01011', s:'COALINDIA',  n:'Coal India',             sec:'Mining',   fo:true,  lot:3300, step:5   },
  { key:'NSE_EQ|INE211T01019', s:'ADANIPORTS', n:'Adani Ports',            sec:'Infra',    fo:true,  lot:625,  step:50  },
  { key:'NSE_EQ|INE669C01036', s:'BPCL',       n:'BPCL',                   sec:'Energy',   fo:true,  lot:1800, step:5   },
  { key:'NSE_EQ|INE752E01010', s:'BRITANNIA',  n:'Britannia Industries',   sec:'FMCG',     fo:true,  lot:200,  step:100 },
  { key:'NSE_EQ|INE214T01019', s:'JSWSTEEL',   n:'JSW Steel',              sec:'Metals',   fo:true,  lot:1350, step:5   },
  { key:'NSE_EQ|INE115A01026', s:'LTI',        n:'LTIMindtree',            sec:'IT',       fo:true,  lot:150,  step:100 },
  { key:'NSE_EQ|INE860A01027', s:'GRASIM',     n:'Grasim Industries',      sec:'Diversif', fo:true,  lot:375,  step:50  },
  { key:'NSE_EQ|INE158A01026', s:'INDUSINDBK', n:'IndusInd Bank',          sec:'Banking',  fo:true,  lot:500,  step:100 },
  { key:'NSE_EQ|INE361B01024', s:'DIVISLAB',   n:'Divi\'s Laboratories',   sec:'Pharma',   fo:true,  lot:200,  step:100 },
  { key:'NSE_EQ|INE694A01020', s:'DRREDDY',    n:'Dr Reddy\'s',            sec:'Pharma',   fo:true,  lot:125,  step:100 },
  { key:'NSE_EQ|INE079A01024', s:'CIPLA',      n:'Cipla',                  sec:'Pharma',   fo:true,  lot:650,  step:50  },
  { key:'NSE_EQ|INE010B01027', s:'HINDALCO',   n:'Hindalco Industries',    sec:'Metals',   fo:true,  lot:1075, step:5   },
  { key:'NSE_EQ|INE256A01028', s:'TECHM',      n:'Tech Mahindra',          sec:'IT',       fo:true,  lot:600,  step:50  },
  { key:'NSE_EQ|INE092T01019', s:'SUNPHARMA',  n:'Sun Pharmaceutical',     sec:'Pharma',   fo:true,  lot:700,  step:50  },
  { key:'NSE_EQ|INE090A01021', s:'ICICIPRULI', n:'ICICI Prudential Life',  sec:'Insurance',fo:true,  lot:750,  step:50  },
  { key:'NSE_EQ|INE238A01034', s:'AXISBANK',   n:'Axis Bank',              sec:'Banking',  fo:true,  lot:625,  step:50  },
  { key:'NSE_EQ|INE027A01015', s:'BAJAJ-AUTO', n:'Bajaj Auto',             sec:'Auto',     fo:true,  lot:125,  step:100 },
  { key:'NSE_EQ|INE326A01037', s:'M&M',        n:'Mahindra & Mahindra',    sec:'Auto',     fo:true,  lot:350,  step:50  },
  { key:'NSE_EQ|INE052A01021', s:'HDFC',       n:'HDFC Ltd',               sec:'Finance',  fo:false, lot:0,    step:0   },
  { key:'NSE_EQ|INE219A01012', s:'EICHERMOT',  n:'Eicher Motors',          sec:'Auto',     fo:true,  lot:175,  step:100 },
  { key:'NSE_EQ|INE148A01019', s:'BHARTIARTL', n:'Bharti Airtel',          sec:'Telecom',  fo:true,  lot:950,  step:50  },
  { key:'NSE_EQ|INE062A01020', s:'SBI',        n:'State Bank of India',    sec:'Banking',  fo:true,  lot:1500, step:10  },
  { key:'NSE_EQ|INE019A01038', s:'TATACONSUM', n:'Tata Consumer Products', sec:'FMCG',     fo:true,  lot:450,  step:50  },
  { key:'NSE_EQ|INE585B01010', s:'AXISBANK',   n:'Axis Bank',              sec:'Banking',  fo:true,  lot:625,  step:50  },
  { key:'NSE_EQ|INE523B01011', s:'SHREECEM',   n:'Shree Cement',           sec:'Cement',   fo:true,  lot:25,   step:100 },
].filter((s, i, arr) => arr.findIndex((x) => x.s === s.s) === i); // deduplicate by symbol
