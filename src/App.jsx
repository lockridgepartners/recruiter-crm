import { useState, useMemo, useEffect, useCallback, useRef } from "react";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://axikdaynkfuwtqaftffq.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4aWtkYXlua2Z1d3RxYWZ0ZmZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NzE3NjMsImV4cCI6MjA5MDI0Nzc2M30.Y2gyYN3Jq0qFNKu5JFBNb1Jase4L6on908XxHanH-_g";

const sb = {
  headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" },

  async select(table) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=created_at.asc`, { headers: sb.headers });
    if (!r.ok) return null;
    return r.json();
  },

  async upsert(table, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...sb.headers, "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });
    if (!r.ok) return null;
    return r.json();
  },

  async remove(table, id) {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method: "DELETE", headers: sb.headers });
  },
};

// ─── DB Schema SQL (run once in Supabase SQL editor) ──────────────────────────
// Paste this into Supabase → SQL Editor → Run:
/*
create table if not exists contacts (id bigint primary key, data jsonb, created_at timestamptz default now());
create table if not exists jobs     (id bigint primary key, data jsonb, created_at timestamptz default now());
create table if not exists clients  (id bigint primary key, data jsonb, created_at timestamptz default now());
create table if not exists activities (id bigint primary key, data jsonb, created_at timestamptz default now());
*/

// ─── Supabase Sync Hook ───────────────────────────────────────────────────────
// Loads data from Supabase on mount, falls back to seed data on first run,
// and syncs every change back automatically.
function useSupabaseTable(table, seedData) {
  const [rows, setRows] = useState(null); // null = loading
  const [synced, setSynced] = useState(false);
  const initialized = useRef(false);

  // Load on mount
  useEffect(() => {
    sb.select(table).then(data => {
      if (data && data.length > 0) {
        // Supabase has data — use it
        setRows(data.map(r => r.data));
      } else {
        // First run — seed Supabase with demo data
        setRows(seedData);
        seedData.forEach(row => sb.upsert(table, { id: row.id, data: row }));
      }
      setSynced(true);
    }).catch(() => {
      // Offline fallback
      setRows(seedData);
      setSynced(true);
    });
  }, [table]);

  // Setter that also persists to Supabase
  const setAndSync = useCallback((updater) => {
    setRows(prev => {
      const next = typeof updater === "function" ? updater(prev || []) : updater;
      if (!next) return next;

      // Diff: find changed/added rows and upsert them
      const prevMap = new Map((prev || []).map(r => [r.id, JSON.stringify(r)]));
      next.forEach(row => {
        if (prevMap.get(row.id) !== JSON.stringify(row)) {
          sb.upsert(table, { id: row.id, data: row });
        }
      });

      // Diff: find removed rows and delete them
      const nextIds = new Set(next.map(r => r.id));
      (prev || []).forEach(row => {
        if (!nextIds.has(row.id)) sb.remove(table, row.id);
      });

      return next;
    });
  }, [table]);

  return [rows, setAndSync, synced];
}

// ─── Gmail Integration ────────────────────────────────────────────────────────
const GMAIL_CLIENT_ID = "996901043803-lbushtfej5f41jej6ls4lccv1a6lfifd.apps.googleusercontent.com";
const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.modify";

// Load Google Identity Services script
function loadGoogleScript() {
  return new Promise(resolve => {
    if (window.google?.accounts) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

// ─── Gmail Hook ───────────────────────────────────────────────────────────────
function useGmail(contacts, clients, setContacts, setClients) {
  const [gmailToken, setGmailToken]   = useState(() => localStorage.getItem("gmail_token") || null);
  const [gmailUser,  setGmailUser]    = useState(() => { try { return JSON.parse(localStorage.getItem("gmail_user") || "null"); } catch { return null; } });
  const [syncing,    setSyncing]      = useState(false);
  const [lastSync,   setLastSync]     = useState(null);
  const [composeOpen,setComposeOpen]  = useState(false);
  const [composeTo,  setComposeTo]    = useState({ name:"", email:"", subject:"", body:"" });
  const tokenRef = useRef(gmailToken);
  tokenRef.current = gmailToken;

  // ── Connect Gmail ──
  const connectGmail = useCallback(async () => {
    await loadGoogleScript();
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GMAIL_CLIENT_ID,
      scope: GMAIL_SCOPES,
      callback: async (resp) => {
        if (resp.error) return;
        const token = resp.access_token;
        // Get user profile
        const profile = await fetch("https://www.googleapis.com/gmail/v1/users/me/profile", {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json());
        setGmailToken(token);
        setGmailUser({ email: profile.emailAddress });
        localStorage.setItem("gmail_token", token);
        localStorage.setItem("gmail_user", JSON.stringify({ email: profile.emailAddress }));
      }
    });
    client.requestAccessToken();
  }, []);

  // ── Disconnect Gmail ──
  const disconnectGmail = useCallback(() => {
    localStorage.removeItem("gmail_token");
    localStorage.removeItem("gmail_user");
    setGmailToken(null);
    setGmailUser(null);
  }, []);

  // ── Fetch emails from Gmail API ──
  const gmailFetch = useCallback(async (url) => {
    if (!tokenRef.current) return null;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tokenRef.current}` } });
    if (r.status === 401) { disconnectGmail(); return null; }
    return r.json();
  }, [disconnectGmail]);

  // ── Parse email headers ──
  const parseHeaders = (headers, name) => headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  const decodeBody = (payload) => {
    const tryDecode = (data) => {
      try { return atob(data.replace(/-/g,"+").replace(/_/g,"/")); } catch { return ""; }
    };
    if (payload?.body?.data) return tryDecode(payload.body.data);
    for (const part of payload?.parts || []) {
      if (part.mimeType === "text/plain" && part.body?.data) return tryDecode(part.body.data);
    }
    return "";
  };

  // ── Collect all known emails from CRM ──
  const getAllKnownEmails = useCallback(() => {
    const map = new Map(); // email -> { type, id, name }
    (contacts||[]).forEach(c => { if(c.email) map.set(c.email.toLowerCase(), { type:"contact", id:c.id, name:c.name }); });
    (clients||[]).forEach(cl => {
      (cl.contacts||[]).forEach(ct => { if(ct.email) map.set(ct.email.toLowerCase(), { type:"client", clientId:cl.id, contactId:ct.id, name:ct.name, clientName:cl.name }); });
    });
    return map;
  }, [contacts, clients]);

  // ── Sync inbox emails ──
  const syncEmails = useCallback(async () => {
    if (!tokenRef.current) return;
    setSyncing(true);
    try {
      const knownEmails = getAllKnownEmails();
      if (knownEmails.size === 0) { setSyncing(false); return; }

      // Build query: match any known email
      const emailList = Array.from(knownEmails.keys()).slice(0, 10); // Gmail query limit
      const q = emailList.map(e => `from:${e} OR to:${e}`).join(" OR ");
      const listData = await gmailFetch(`https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`);
      if (!listData?.messages) { setSyncing(false); return; }

      // Fetch each message
      const messages = await Promise.all(
        listData.messages.slice(0, 20).map(m =>
          gmailFetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`)
        )
      );

      // Build activity entries per matched contact
      const newActivitiesByContact = new Map(); // contactKey -> [{...}]

      messages.forEach(msg => {
        if (!msg?.payload) return;
        const headers = msg.payload.headers || [];
        const from    = parseHeaders(headers, "From");
        const to      = parseHeaders(headers, "To");
        const subject = parseHeaders(headers, "Subject");
        const date    = parseHeaders(headers, "Date");
        const snippet = msg.snippet || "";
        const body    = decodeBody(msg.payload);
        const msgId   = msg.id;

        // Check from/to against known emails
        const allAddresses = `${from} ${to}`.toLowerCase();
        knownEmails.forEach((info, email) => {
          if (!allAddresses.includes(email)) return;
          const key = `${info.type}:${info.id||info.clientId+":"+info.contactId}`;
          if (!newActivitiesByContact.has(key)) newActivitiesByContact.set(key, { info, emails:[] });
          newActivitiesByContact.get(key).emails.push({
            id: `gmail_${msgId}`,
            type: "email",
            gmailId: msgId,
            subject,
            snippet,
            body: body.slice(0, 800),
            from,
            to,
            date,
            time: new Date(date).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}),
            dateFormatted: new Date(date).toLocaleDateString("en-US", {month:"short",day:"numeric",year:"numeric"}),
            direction: from.toLowerCase().includes(gmailUser?.email?.toLowerCase()||"me@") ? "sent" : "received",
          });
        });
      });

      // Merge into contacts
      if (newActivitiesByContact.size > 0) {
        setContacts(prev => {
          if (!prev) return prev;
          return prev.map(c => {
            const key = `contact:${c.id}`;
            if (!newActivitiesByContact.has(key)) return c;
            const { emails } = newActivitiesByContact.get(key);
            const existingIds = new Set((c.gmailEmails||[]).map(e => e.id));
            const newEmails = emails.filter(e => !existingIds.has(e.id));
            if (newEmails.length === 0) return c;
            return { ...c, gmailEmails: [...newEmails, ...(c.gmailEmails||[])] };
          });
        });
        setClients(prev => {
          if (!prev) return prev;
          return prev.map(cl => {
            const updatedContacts = cl.contacts.map(ct => {
              const key = `client:${cl.id}:${ct.id}`;
              if (!newActivitiesByContact.has(key)) return ct;
              const { emails } = newActivitiesByContact.get(key);
              const existingIds = new Set((ct.gmailEmails||[]).map(e => e.id));
              const newEmails = emails.filter(e => !existingIds.has(e.id));
              if (newEmails.length === 0) return ct;
              return { ...ct, gmailEmails: [...newEmails, ...(ct.gmailEmails||[])] };
            });
            return { ...cl, contacts: updatedContacts };
          });
        });
      }
      setLastSync(new Date());
    } catch(e) { console.error("Gmail sync error:", e); }
    setSyncing(false);
  }, [gmailFetch, getAllKnownEmails, gmailUser, setContacts, setClients]);

  // Auto-sync on connect and every 5 minutes
  useEffect(() => {
    if (!gmailToken) return;
    syncEmails();
    const interval = setInterval(syncEmails, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [gmailToken, syncEmails]);

  // ── Send email via Gmail ──
  const sendEmail = useCallback(async ({ to, subject, body }) => {
    if (!tokenRef.current) return false;
    const raw = [`To: ${to}`, `Subject: ${subject}`, `Content-Type: text/plain; charset=utf-8`, "", body]
      .join("\r\n");
    const encoded = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    const r = await fetch("https://www.googleapis.com/gmail/v1/users/me/messages/send", {
      method:"POST",
      headers:{ Authorization:`Bearer ${tokenRef.current}`, "Content-Type":"application/json" },
      body: JSON.stringify({ raw: encoded })
    });
    return r.ok;
  }, []);

  // ── Open compose ──
  const openCompose = useCallback((preset={}) => {
    setComposeTo({ name:"", email:"", subject:"", body:"", ...preset });
    setComposeOpen(true);
  }, []);

  return { gmailToken, gmailUser, syncing, lastSync, connectGmail, disconnectGmail, syncEmails, sendEmail, openCompose, composeOpen, setComposeOpen, composeTo, setComposeTo };
}

// ─── Gmail Compose Modal — centered floating card ─────────────────────────────
function GmailComposeModal({ composeTo, setComposeTo, onSend, onClose }) {
  const [sending, setSending] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState("");

  const handleSend = async () => {
    if (!composeTo.email || !composeTo.subject) { setError("Email and subject are required."); return; }
    setSending(true); setError("");
    const ok = await onSend({ to: composeTo.email, subject: composeTo.subject, body: composeTo.body });
    setSending(false);
    if (ok) { setSent(true); setTimeout(onClose, 1400); }
    else setError("Failed to send. Check your Gmail connection.");
  };

  return (
    <div
      onClick={onClose}
      onTouchMove={e=>e.stopPropagation()}
      onWheel={e=>e.stopPropagation()}
      style={{position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"24px 20px",background:"rgba(0,0,0,0.48)",backdropFilter:"blur(6px)",touchAction:"none"}}
    >
      <div
        onClick={e=>e.stopPropagation()}
        onTouchMove={e=>e.stopPropagation()}
        className="pop-in"
        style={{background:T.bg,borderRadius:22,width:"100%",maxWidth:380,maxHeight:"82%",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 60px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.2)",touchAction:"auto"}}
      >
        {/* Coloured header */}
        <div style={{flexShrink:0,background:"linear-gradient(135deg,#EA4335,#FBBC04)",padding:"15px 14px 13px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,borderRadius:9,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <Icon name="mail" size={17} color="#fff" strokeWidth={1.9}/>
            </div>
            <div>
              <div style={{...sf(16,700,"#fff")}}>New Email</div>
              <div style={{...sf(11,400,"rgba(255,255,255,0.75)"),marginTop:1}}>{composeTo.name||composeTo.email||"Compose"}</div>
            </div>
          </div>
          <div className="tap" onClick={onClose} style={{width:26,height:26,borderRadius:13,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="dismiss" size={13} color="#fff" strokeWidth={2.4}/>
          </div>
        </div>

        {/* Fields */}
        <div style={{flex:1,overflowY:"auto",overscrollBehavior:"contain"}}>
          {[
            {label:"To",     key:"email",   ph:"recipient@email.com"},
            {label:"Subject",key:"subject", ph:"Subject line…"},
          ].map(f=>(
            <div key={f.key} style={{borderBottom:`0.5px solid ${T.sep}`,display:"flex",alignItems:"center",padding:"11px 14px",gap:10}}>
              <div style={{width:54,flexShrink:0,...sf(13,500,T.label3)}}>{f.label}</div>
              <input
                value={composeTo[f.key]}
                onChange={e=>setComposeTo(p=>({...p,[f.key]:e.target.value}))}
                placeholder={f.ph}
                style={{flex:1,border:"none",outline:"none",...sf(14,400,T.label),background:"transparent"}}
              />
            </div>
          ))}
          <div style={{padding:"12px 14px"}}>
            <textarea
              value={composeTo.body}
              onChange={e=>setComposeTo(p=>({...p,body:e.target.value}))}
              placeholder="Write your message…"
              rows={8}
              style={{width:"100%",border:"none",outline:"none",...sf(14,400,T.label),background:"transparent",resize:"none",lineHeight:1.65,minHeight:160}}
            />
          </div>
          {error&&<div style={{...sf(12,400,T.red),padding:"0 14px 10px"}}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={{flexShrink:0,padding:"10px 14px 14px",borderTop:`0.5px solid ${T.sep}`,display:"flex",gap:8,alignItems:"center"}}>
          {sent ? (
            <div style={{display:"flex",alignItems:"center",gap:7,...sf(14,600,T.green)}}>
              <Icon name="check" size={16} color={T.green} strokeWidth={2}/>Sent!
            </div>
          ) : (
            <>
              <button onClick={handleSend} disabled={sending} className="tap"
                style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:7,border:"none",borderRadius:12,padding:"11px 0",background:"#EA4335",color:"#fff",...sf(15,600,"#fff"),cursor:"pointer"}}>
                <Icon name="send" size={15} color="#fff" strokeWidth={2}/>{sending?"Sending…":"Send"}
              </button>
              <GhostBtn label="Cancel" color={T.gray} onPress={onClose}/>
            </>
          )}
        </div>

        {/* Tap outside hint */}
        <div style={{flexShrink:0,padding:"4px 0 10px",textAlign:"center"}}>
          <div style={{...sf(11,400,T.label3)}}>Tap outside to close</div>
        </div>
      </div>
    </div>
  );
}

// ─── Gmail Email Thread View (inside a contact/candidate profile) ─────────────
function GmailThreadView({ emails, contactName }) {
  const [openId, setOpenId] = useState(null);
  if (!emails || emails.length === 0) return (
    <div style={{textAlign:"center",padding:"16px 0",color:T.label3,...sf(12,400,T.label3)}}>
      No emails synced yet. Gmail auto-syncs every 5 min.
    </div>
  );
  return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {emails.map(e=>(
        <div key={e.id} className="tap" onClick={()=>setOpenId(p=>p===e.id?null:e.id)}
          style={{background:T.bg,borderRadius:10,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          {/* Collapsed row */}
          <div style={{padding:"10px 12px",display:"flex",alignItems:"flex-start",gap:9}}>
            <div style={{width:28,height:28,borderRadius:8,background:e.direction==="sent"?"rgba(0,122,255,0.10)":"rgba(234,67,53,0.10)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>
              <Icon name={e.direction==="sent"?"send":"mail"} size={13} color={e.direction==="sent"?T.blue:"#EA4335"} strokeWidth={1.8}/>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8}}>
                <div style={{...sf(13,600,T.label),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{e.subject||"(no subject)"}</div>
                <div style={{...sf(10,400,T.label3),flexShrink:0}}>{e.dateFormatted}</div>
              </div>
              <div style={{...sf(11,400,T.label3),marginTop:2}}>{e.direction==="sent"?`To: ${e.to}`:`From: ${e.from}`}</div>
              {openId!==e.id&&<div style={{...sf(12,400,T.label3),marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.snippet}</div>}
            </div>
            <div style={{transform:openId===e.id?"rotate(90deg)":"rotate(0deg)",transition:`transform 0.2s ${T.ease}`,flexShrink:0,display:"flex",marginTop:4}}>
              <Icon name="chevronRight" size={13} color={T.gray3} strokeWidth={2}/>
            </div>
          </div>
          {/* Expanded body */}
          {openId===e.id&&(
            <div style={{borderTop:`0.5px solid ${T.sep}`,padding:"10px 12px"}}>
              <div style={{...sf(12,400,T.label2),lineHeight:1.7,whiteSpace:"pre-wrap"}}>{e.body||e.snippet}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Gmail Status Bar (shown in Dashboard header) ─────────────────────────────
function GmailStatusBar({ gmailUser, syncing, lastSync, onConnect, onDisconnect, onSync }) {
  if (!gmailUser) {
    return (
      <div className="tap" onClick={onConnect}
        style={{display:"flex",alignItems:"center",gap:10,background:"rgba(234,67,53,0.07)",borderRadius:12,padding:"10px 14px",marginTop:12,border:"0.5px solid rgba(234,67,53,0.18)"}}>
        <div style={{width:32,height:32,borderRadius:9,background:"#EA4335",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <Icon name="mail" size={16} color="#fff" strokeWidth={2}/>
        </div>
        <div style={{flex:1}}>
          <div style={{...sf(13,600,T.label)}}>Connect Gmail</div>
          <div style={{...sf(11,400,T.label3),marginTop:1}}>Auto-log emails to every contact</div>
        </div>
        <Icon name="chevronRight" size={14} color={T.label3} strokeWidth={2}/>
      </div>
    );
  }
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,background:"rgba(52,199,89,0.07)",borderRadius:12,padding:"10px 14px",marginTop:12,border:"0.5px solid rgba(52,199,89,0.18)"}}>
      <div style={{width:32,height:32,borderRadius:9,background:"#EA4335",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <Icon name="mail" size={16} color="#fff" strokeWidth={2}/>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{...sf(13,600,T.label)}}>Gmail Connected</div>
        <div style={{...sf(11,400,T.label3),marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          {gmailUser.email} · {lastSync ? `Synced ${lastSync.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}` : "Tap ↻ to sync"}
        </div>
      </div>
      <div className="tap" onClick={onSync} style={{marginRight:4}}><Icon name="activity" size={16} color={T.green} strokeWidth={2}/></div>
      <div className="tap" onClick={onDisconnect}><Icon name="dismiss" size={14} color={T.gray3} strokeWidth={2}/></div>
    </div>
  );
}

// ─── Loading Screen ───────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div style={{position:"absolute",inset:0,background:"#FFFFFF",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,zIndex:999}}>
      <div style={{width:56,height:56,borderRadius:16,background:"linear-gradient(135deg,#007AFF,#AF52DE)",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>
        </svg>
      </div>
      <div style={{fontFamily:"-apple-system,sans-serif",fontSize:17,fontWeight:600,color:"#000",letterSpacing:"-0.012em"}}>Loading your CRM…</div>
      <div style={{fontFamily:"-apple-system,sans-serif",fontSize:13,color:"rgba(60,60,67,0.55)"}}>Syncing with Supabase</div>
    </div>
  );
}

// ─── Tokens ───────────────────────────────────────────────────────────────────
const T={
  bg:"#FFFFFF",card:"#FFFFFF",
  label:"#000",label2:"rgba(60,60,67,0.80)",label3:"rgba(60,60,67,0.55)",
  sep:"rgba(60,60,67,0.10)",
  blue:"#007AFF",green:"#34C759",orange:"#FF9500",red:"#FF3B30",
  purple:"#AF52DE",teal:"#5AC8FA",indigo:"#5856D6",
  gray:"#8E8E93",gray3:"#C7C7CC",gray4:"#D1D1D6",gray5:"#EFEFEF",gray6:"#F7F7F7",
  r:13,rLg:20,spring:"cubic-bezier(0.34,1.56,0.64,1)",ease:"cubic-bezier(0.25,0.46,0.45,0.94)",
};

const GS=()=>(
  <style>{`
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;margin:0;padding:0;}
    html,body{height:100%;width:100%;overflow:hidden;background:#FFFFFF;touch-action:pan-x pan-y;-ms-touch-action:pan-x pan-y;}
    body{margin:0;background:#fff;}
    input,textarea{-webkit-appearance:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}
    ::-webkit-scrollbar{display:none;}
    /* Prevent all pinch-zoom and double-tap zoom */
    html{touch-action:manipulation;}
    body{touch-action:manipulation;}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes slideUp{from{transform:translateY(30px);opacity:0}to{transform:translateY(0);opacity:1}}
    @keyframes popIn{0%{transform:scale(0.88);opacity:0}60%{transform:scale(1.03)}100%{transform:scale(1);opacity:1}}
    @keyframes expandDown{from{max-height:0;opacity:0}to{max-height:3000px;opacity:1}}
    @keyframes sheetIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
    .fade-in{animation:fadeIn 0.22s ease both;}
    .slide-up{animation:slideUp 0.28s cubic-bezier(0.25,0.46,0.45,0.94) both;}
    .pop-in{animation:popIn 0.32s cubic-bezier(0.34,1.56,0.64,1) both;}
    .expand{animation:expandDown 0.3s cubic-bezier(0.25,0.46,0.45,0.94) both;overflow:hidden;}
    .sheet-in{animation:sheetIn 0.36s cubic-bezier(0.34,1.56,0.64,1) both;}
    .tap{transition:transform 0.11s ease,opacity 0.11s ease;cursor:pointer;user-select:none;}
    .tap:active{transform:scale(0.96);opacity:0.75;}
    /* PWA safe area support for iPhone notch and home indicator */
    .safe-top{padding-top:env(safe-area-inset-top, 44px);}
    .safe-bottom{padding-bottom:env(safe-area-inset-bottom, 20px);}
  `}</style>
);

// ─── SVG Icons ────────────────────────────────────────────────────────────────
const Icon=({name,size=20,color=T.gray,strokeWidth=1.5})=>{
  const s={width:size,height:size,flexShrink:0,display:"block"};
  const p={stroke:color,strokeWidth,strokeLinecap:"round",strokeLinejoin:"round",fill:"none"};
  const icons={
    house:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1z"/><path {...p} d="M9 21V12h6v9"/></svg>,
    chart:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="3" y="14" width="4" height="7" rx="1"/><rect {...p} x="10" y="9" width="4" height="12" rx="1"/><rect {...p} x="17" y="4" width="4" height="17" rx="1"/></svg>,
    people:<svg style={s} viewBox="0 0 24 24"><circle {...p} cx="9" cy="7" r="4"/><path {...p} d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/><path {...p} d="M16 3.13a4 4 0 010 7.75M21 21v-2a4 4 0 00-3-3.85"/></svg>,
    briefcase:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="2" y="7" width="20" height="14" rx="2"/><path {...p} d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2M2 12h20"/></svg>,
    clients:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="2" y="3" width="20" height="14" rx="2"/><path {...p} d="M8 21h8m-4-4v4"/><circle {...p} cx="8" cy="10" r="2"/><path {...p} d="M14 10h4M14 13h3"/></svg>,
    phone:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.79 19.79 0 01.01 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92v2z"/></svg>,
    mail:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="2" y="4" width="20" height="16" rx="2"/><polyline {...p} points="2,4 12,13 22,4"/></svg>,
    money:<svg style={s} viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="10"/><path {...p} d="M12 6v2m0 8v2M9 9h4.5a2 2 0 010 4H10a2 2 0 000 4H15"/></svg>,
    clock:<svg style={s} viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="10"/><polyline {...p} points="12,6 12,12 16,14"/></svg>,
    fire:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M12 2c0 6-8 8-8 14a8 8 0 0016 0c0-2-1-4-2-5-1 3-3 4-3 4s1-4-3-9z"/><path {...p} d="M12 14c0 2-1.5 3-1.5 3s2.5-1 2.5-4c0 0 1 1.5 1 3"/></svg>,
    star:<svg style={s} viewBox="0 0 24 24"><polygon {...p} points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>,
    note:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline {...p} points="14,2 14,8 20,8"/><line {...p} x1="16" y1="13" x2="8" y2="13"/><line {...p} x1="16" y1="17" x2="8" y2="17"/></svg>,
    send:<svg style={s} viewBox="0 0 24 24"><line {...p} x1="22" y1="2" x2="11" y2="13"/><polygon {...p} points="22,2 15,22 11,13 2,9"/></svg>,
    person:<svg style={s} viewBox="0 0 24 24"><circle {...p} cx="12" cy="8" r="5"/><path {...p} d="M3 21v-2a7 7 0 0114 0v2"/></svg>,
    alert:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line {...p} x1="12" y1="9" x2="12" y2="13"/><line {...p} x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    check:<svg style={s} viewBox="0 0 24 24"><polyline {...p} points="20,6 9,17 4,12"/></svg>,
    checkCircle:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline {...p} points="22,4 12,14.01 9,11.01"/></svg>,
    plus:<svg style={s} viewBox="0 0 24 24"><line {...p} x1="12" y1="5" x2="12" y2="19"/><line {...p} x1="5" y1="12" x2="19" y2="12"/></svg>,
    chevronRight:<svg style={s} viewBox="0 0 24 24"><polyline {...p} points="9,18 15,12 9,6"/></svg>,
    edit:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path {...p} d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
    trash:<svg style={s} viewBox="0 0 24 24"><polyline {...p} points="3,6 5,6 21,6"/><path {...p} d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6m4-6v6"/><path {...p} d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
    resume:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="3" y="2" width="18" height="20" rx="2"/><path {...p} d="M9 7h6"/><circle {...p} cx="12" cy="11" r="2.5"/><path {...p} d="M7 18c0-2 2.2-3.5 5-3.5s5 1.5 5 3.5"/></svg>,
    upload:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline {...p} points="17,8 12,3 7,8"/><line {...p} x1="12" y1="3" x2="12" y2="15"/></svg>,
    link:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path {...p} d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
    expand:<svg style={s} viewBox="0 0 24 24"><polyline {...p} points="15,3 21,3 21,9"/><polyline {...p} points="9,21 3,21 3,15"/><line {...p} x1="21" y1="3" x2="14" y2="10"/><line {...p} x1="3" y1="21" x2="10" y2="14"/></svg>,
    collapse:<svg style={s} viewBox="0 0 24 24"><polyline {...p} points="4,14 10,14 10,20"/><polyline {...p} points="20,10 14,10 14,4"/><line {...p} x1="10" y1="14" x2="3" y2="21"/><line {...p} x1="21" y1="3" x2="14" y2="10"/></svg>,
    calendar:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="3" y="4" width="18" height="18" rx="2"/><line {...p} x1="16" y1="2" x2="16" y2="6"/><line {...p} x1="8" y1="2" x2="8" y2="6"/><line {...p} x1="3" y1="10" x2="21" y2="10"/></svg>,
    description:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline {...p} points="14,2 14,8 20,8"/><line {...p} x1="16" y1="13" x2="8" y2="13"/><line {...p} x1="16" y1="17" x2="8" y2="17"/></svg>,
    globe:<svg style={s} viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="10"/><line {...p} x1="2" y1="12" x2="22" y2="12"/><path {...p} d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
    industry:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M2 20h20"/><rect {...p} x="4" y="4" width="6" height="16"/><path {...p} d="M14 8l6-4v16"/><rect {...p} x="10" y="12" width="4" height="8"/></svg>,
    revenue:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
    signal:<svg style={s} viewBox="0 0 24 24"><rect stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill={color} x="2" y="16" width="3" height="6" rx="1"/><rect stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill={color} x="8" y="11" width="3" height="11" rx="1"/><rect stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill={color} x="14" y="6" width="3" height="16" rx="1"/><rect stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill={color} x="20" y="2" width="3" height="20" rx="1"/></svg>,
    wifi:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M5 12.55a11 11 0 0114.08 0"/><path {...p} d="M1.42 9a16 16 0 0121.16 0"/><path {...p} d="M8.53 16.11a6 6 0 016.95 0"/><line {...p} x1="12" y1="20" x2="12.01" y2="20"/></svg>,
    battery:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="1" y="6" width="18" height="12" rx="2"/><line {...p} x1="23" y1="13" x2="23" y2="11"/><path stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill={color} d="M4 9h8v6H4z"/></svg>,
    contact:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle {...p} cx="9" cy="7" r="4"/><path {...p} d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>,
    building:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="3" y="2" width="18" height="20" rx="1"/><path {...p} d="M9 22V12h6v10"/><rect {...p} x="7" y="6" width="3" height="3"/><rect {...p} x="14" y="6" width="3" height="3"/><rect {...p} x="7" y="12" width="3" height="3"/><rect {...p} x="14" y="12" width="3" height="3"/></svg>,
    sparkle:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>,
    brain:<svg style={s} viewBox="0 0 24 24"><path {...p} d="M9.5 2a2.5 2.5 0 000 5H12"/><path {...p} d="M14.5 2a2.5 2.5 0 010 5H12v0"/><path {...p} d="M12 7v10"/><path {...p} d="M7 10.5A2.5 2.5 0 004.5 13a2.5 2.5 0 002.5 2.5"/><path {...p} d="M17 10.5a2.5 2.5 0 012.5 2.5 2.5 2.5 0 01-2.5 2.5"/><path {...p} d="M9 17a3 3 0 006 0"/><path {...p} d="M7 15.5V17a5 5 0 0010 0v-1.5"/></svg>,
    zap:<svg style={s} viewBox="0 0 24 24"><polygon {...p} points="13,2 3,14 12,14 11,22 21,10 12,10 13,2"/></svg>,
    target:<svg style={s} viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="10"/><circle {...p} cx="12" cy="12" r="6"/><circle {...p} cx="12" cy="12" r="2"/></svg>,
    arrowUp:<svg style={s} viewBox="0 0 24 24"><line {...p} x1="12" y1="19" x2="12" y2="5"/><polyline {...p} points="5,12 12,5 19,12"/></svg>,
    dismiss:<svg style={s} viewBox="0 0 24 24"><line {...p} x1="18" y1="6" x2="6" y2="18"/><line {...p} x1="6" y1="6" x2="18" y2="18"/></svg>,
    building2:<svg style={s} viewBox="0 0 24 24"><rect {...p} x="2" y="7" width="9" height="14" rx="1"/><rect {...p} x="11" y="3" width="11" height="18" rx="1"/><line {...p} x1="6" y1="11" x2="6" y2="11"/><line {...p} x1="6" y1="15" x2="6" y2="15"/><line {...p} x1="16" y1="7" x2="16" y2="7"/><line {...p} x1="16" y1="11" x2="16" y2="11"/><line {...p} x1="16" y1="15" x2="16" y2="15"/></svg>,
  };
  return icons[name]||<svg style={s} viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="8"/></svg>;
};

function IconBadge({name,bg,iconColor,size=36}){
  return <div style={{width:size,height:size,borderRadius:size*0.28,background:bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={name} size={size*0.52} color={iconColor} strokeWidth={1.6}/></div>;
}

// ─── Seed Data ────────────────────────────────────────────────────────────────
const seedContacts=[
  {id:1,name:"Sarah Chen",title:"Sr. Software Engineer",company:"Stripe",stage:"Offer",tags:["React","Node","TypeScript"],phone:"+1 415 555 0192",email:"s.chen@email.com",lastContact:"2h ago",lastContactDays:0,avatar:"SC",hot:true,notes:"Accepted verbal offer. Discussing start date and equity package.",salary:"$210k",
   resume:{summary:"8+ years building scalable web infrastructure. Led frontend platform team at Stripe.",experience:[{role:"Sr. Software Engineer",company:"Stripe",period:"2020–Present",notes:"Led frontend platform team of 8."},{role:"Software Engineer",company:"Lyft",period:"2017–2020",notes:"Built real-time driver tracking UI."}],education:"B.S. CS, Stanford, 2017",linkedIn:"linkedin.com/in/sarahchen"},
   bdPitch:`SUBJECT: Full-Time Senior Software Engineer (8+ yrs exp) - For [Client Company Name]

Hi [Contact Name],

I am representing an 8-year Senior Software Engineer who is open to relocation and actively exploring a new full-time position.

They bring 8+ years of software engineering experience with a strong frontend infrastructure foundation, having worked across high-growth fintech and transportation platforms serving millions of users. Most recently, they have been leading Stripe's frontend platform team of 8 engineers — owning the component library used by 200+ internal engineers — and are known for a rare combination of technical depth and cross-functional leadership.

A few quick highlights:
• B.S. Computer Science – Stanford University, 2017
• Prior experience with Stripe and Lyft
• Expert-level React, Node.js, and TypeScript
• Built and scaled frontend infrastructure handling hundreds of millions in payment volume
• Reduced driver tracking latency 40% at Lyft through WebSocket architecture optimization
• Available for interviews [please confirm availability]

They are actively exploring new opportunities and highly motivated to secure the right fit quickly.

Let me know if you'd like to see their resume.`},
  {id:2,name:"Marcus Webb",title:"Product Manager",company:"Airbnb",stage:"Interview",tags:["B2B","SaaS","Growth"],phone:"+1 628 555 0341",email:"m.webb@email.com",lastContact:"1d ago",lastContactDays:1,avatar:"MW",hot:false,notes:"Final round Thursday with VP of Product. 3 other finalists.",salary:"$185k",resume:null,bdPitch:""},
  {id:3,name:"Priya Nair",title:"Head of Design",company:"Figma",stage:"Screening",tags:["UX","Brand"],phone:"+1 650 555 0728",email:"p.nair@email.com",lastContact:"3d ago",lastContactDays:3,avatar:"PN",hot:true,notes:"Strong portfolio. Culture fit concern raised by hiring manager.",salary:"$195k",resume:null,bdPitch:""},
  {id:4,name:"James Okafor",title:"Data Engineer",company:"Databricks",stage:"Sourced",tags:["Python","Spark"],phone:"+1 510 555 0914",email:"j.okafor@email.com",lastContact:"5d ago",lastContactDays:5,avatar:"JO",hot:false,notes:"Referral from Marcus Webb. 6 YOE. Actively looking.",salary:"$175k",resume:null,bdPitch:""},
  {id:5,name:"Elena Vasquez",title:"CTO",company:"NeuralPath",stage:"Placed",tags:["Leadership","ML"],phone:"+1 312 555 0563",email:"e.vasquez@email.com",lastContact:"1w ago",lastContactDays:7,avatar:"EV",hot:false,notes:"Placed at NeuralPath. $72.5k fee invoiced. Great outcome.",salary:"$290k",resume:null,bdPitch:""},
  {id:6,name:"Tom Huang",title:"DevOps Lead",company:"Cloudflare",stage:"Screening",tags:["K8s","AWS"],phone:"+1 415 555 0187",email:"t.huang@email.com",lastContact:"2d ago",lastContactDays:2,avatar:"TH",hot:false,notes:"Available in 60 days. Strong K8s background.",salary:"$165k",resume:null,bdPitch:""},
];

const seedJobs=[
  {id:1,title:"VP of Engineering",company:"FinTech Corp",fee:"$68,000",stage:"Active",candidates:4,deadline:"Mar 15",deadlineDays:-12,urgent:true,notes:"Board approved. Budget flexible.",description:"Lead our 80-person engineering org.\n\nRequirements\n• 10+ years engineering leadership\n• Track record scaling platforms to $1B+ TPS\n\nCompensation\n$320k–$380k + equity"},
  {id:2,title:"Senior ML Engineer",company:"HealthAI",fee:"$42,000",stage:"Active",candidates:7,deadline:"Apr 2",deadlineDays:6,urgent:false,notes:"Remote ok. PyTorch required.",description:"Build production ML models for clinical NLP.\n\nRequirements\n• 5+ years ML engineering\n• Expert Python, PyTorch\n\nCompensation\n$180k–$220k + equity, remote"},
  {id:3,title:"Head of Product",company:"RetailTech",fee:"$55,000",stage:"Pending",candidates:2,deadline:"Apr 20",deadlineDays:24,urgent:false,notes:"Awaiting signed retainer.",description:"Own product roadmap across SaaS platform.\n\nRequirements\n• 8+ years PM, 3+ years leading teams\n\nCompensation\n$210k–$250k + equity"},
  {id:4,title:"Staff Engineer",company:"Crypto Startup",fee:"$38,000",stage:"Filled",candidates:12,deadline:"Feb 28",deadlineDays:-27,urgent:false,notes:"Placed Aisha Ramos.",description:"Role filled."},
];

const seedClients=[
  {id:1,name:"FinTech Corp",industry:"Financial Technology",status:"Active",website:"fintechcorp.io",revenue:"$120M ARR",employees:"450",address:"535 Mission St, San Francisco, CA",since:"Jan 2023",totalFees:"$143,000",openRoles:2,lastOutreach:"3d ago",lastOutreachDays:3,
   primaryContact:{name:"Dana Park",title:"VP Talent",email:"d.park@fintechcorp.io",phone:"+1 415 555 0201"},
   contacts:[
     {id:1,name:"Dana Park",title:"VP of Talent Acquisition",email:"d.park@fintechcorp.io",phone:"+1 415 555 0201",primary:true,
      activities:[
        {id:1,type:"call",  text:"Called to discuss VP of Engineering search progress. She wants 3 finalists by end of month.",date:"Mar 25, 2025",time:"11:30 AM"},
        {id:2,type:"email", text:"Sent updated candidate profiles — Sarah Chen and Marcus Webb included.",date:"Mar 20, 2025",time:"9:15 AM"},
        {id:3,type:"meeting",text:"Kickoff meeting for Q2 headcount expansion. 6 new roles confirmed.",date:"Feb 14, 2025",time:"2:00 PM"},
      ]},
     {id:2,name:"Raj Mehta",title:"CTO",email:"r.mehta@fintechcorp.io",phone:"+1 415 555 0342",primary:false,
      activities:[
        {id:1,type:"note",text:"Raj prefers candidates with distributed systems background. Hard requirement on $1B+ TPS experience.",date:"Mar 10, 2025",time:"3:00 PM"},
        {id:2,type:"call", text:"Intro call. Will be on the final interview panel for VP of Engineering.",date:"Feb 20, 2025",time:"10:00 AM"},
      ]},
   ],
   linkedJobs:[1],
   notes:[{id:1,text:"Retainer signed Jan 2023. Exclusive agreement for VP-level roles.",date:"Jan 12, 2023"},{id:2,text:"Board approved headcount expansion — 6 new engineering roles expected in Q2 2025.",date:"Feb 14, 2025"}],
   tags:["Retainer","FinTech","Series D"],logo:"FC",logoColor:"#007AFF"},
  {id:2,name:"HealthAI",industry:"Health Technology",status:"Active",website:"healthai.com",revenue:"$28M ARR",employees:"120",address:"200 Berkeley St, Boston, MA",since:"Sep 2024",totalFees:"$42,000",openRoles:1,lastOutreach:"1d ago",lastOutreachDays:1,
   primaryContact:{name:"Marco Ellis",title:"CEO",email:"m.ellis@healthai.com",phone:"+1 617 555 0188"},
   contacts:[
     {id:1,name:"Marco Ellis",title:"CEO",email:"m.ellis@healthai.com",phone:"+1 617 555 0188",primary:true,
      activities:[
        {id:1,type:"call",  text:"Weekly check-in. Marco is personally reviewing all ML Engineer candidates.",date:"Mar 26, 2025",time:"4:00 PM"},
        {id:2,type:"email", text:"Sent 4 ML Engineer profiles. He shortlisted 2 for technical screen.",date:"Mar 19, 2025",time:"8:45 AM"},
        {id:3,type:"intro", text:"First intro call — agreed on contingency basis, 20% fee on base salary.",date:"Sep 10, 2024",time:"11:00 AM"},
      ]},
   ],
   linkedJobs:[2],
   notes:[{id:1,text:"First engagement. Contingency basis. Marco hands-on in technical interviews.",date:"Sep 10, 2024"}],
   tags:["Contingency","HealthTech","Series B"],logo:"HA",logoColor:"#34C759"},
  {id:3,name:"RetailTech",industry:"Retail Software",status:"Pending",website:"retailtech.co",revenue:"$9M ARR",employees:"60",address:"330 N Wabash Ave, Chicago, IL",since:"Mar 2025",totalFees:"$0",openRoles:1,lastOutreach:"7d ago",lastOutreachDays:7,
   primaryContact:{name:"Chris Nguyen",title:"COO",email:"c.nguyen@retailtech.co",phone:"+1 312 555 0310"},
   contacts:[
     {id:1,name:"Chris Nguyen",title:"COO",email:"c.nguyen@retailtech.co",phone:"+1 312 555 0310",primary:true,
      activities:[
        {id:1,type:"note",  text:"Retainer still unsigned. Follow up needed — Chris said budget is approved but legal is reviewing.",date:"Mar 20, 2025",time:"1:00 PM"},
        {id:2,type:"call",  text:"Discovery call. Needs Head of Product with B2B SaaS background. Timeline is Q2.",date:"Mar 12, 2025",time:"10:00 AM"},
      ]},
   ],
   linkedJobs:[3],
   notes:[{id:1,text:"Awaiting signed retainer. Budget confirmed.",date:"Mar 20, 2025"}],
   tags:["Pending","RetailTech","Series A"],logo:"RT",logoColor:"#FF9500"},
  {id:4,name:"Crypto Startup",industry:"Web3 / Blockchain",status:"Closed",website:"cryptostartup.xyz",revenue:"$4M ARR",employees:"28",address:"1 Hacker Way, Palo Alto, CA",since:"Nov 2023",totalFees:"$38,000",openRoles:0,lastOutreach:"14d ago",lastOutreachDays:14,
   primaryContact:{name:"Alex Wu",title:"Founder & CEO",email:"a.wu@cryptostartup.xyz",phone:"+1 650 555 0567"},
   contacts:[
     {id:1,name:"Alex Wu",title:"Founder & CEO",email:"a.wu@cryptostartup.xyz",phone:"+1 650 555 0567",primary:true,
      activities:[
        {id:1,type:"note",  text:"Engagement closed. Placed Aisha Ramos as Staff Engineer. May reopen for a second role in Q3.",date:"Mar 5, 2024",time:"9:00 AM"},
        {id:2,type:"email", text:"Sent placement confirmation and invoice for $38,000. Alex very happy with the outcome.",date:"Feb 29, 2024",time:"3:30 PM"},
      ]},
   ],
   linkedJobs:[4],
   notes:[{id:1,text:"Engagement closed. Placed Aisha Ramos. May reopen in Q3 2025.",date:"Mar 5, 2024"}],
   tags:["Closed","Web3","Seed"],logo:"CS",logoColor:"#AF52DE"},
];

const seedActivities=[
  {id:1,iconName:"phone",iconBg:"rgba(52,199,89,0.12)",iconColor:T.green,text:"Called Sarah Chen — verbal offer discussion",time:"2h ago",detail:"Duration: 24 min. Discussed comp and RSU vesting. Wants 10% more equity before signing."},
  {id:2,iconName:"star",iconBg:"rgba(255,149,0,0.12)",iconColor:T.orange,text:"Placement confirmed: Elena Vasquez → NeuralPath",time:"1d ago",detail:"Fee of $72,500 invoiced. Net 30 payment terms."},
  {id:3,iconName:"note",iconBg:"rgba(0,122,255,0.12)",iconColor:T.blue,text:"Note — Marcus Webb final round scheduled",time:"1d ago",detail:"Thursday 2pm PST. Panel with VP of Product and CTO."},
  {id:4,iconName:"send",iconBg:"rgba(175,82,222,0.12)",iconColor:T.purple,text:"Intro sent: Tom Huang → Cloudflare",time:"2d ago",detail:"Resume attached. Awaiting response from hiring manager."},
  {id:5,iconName:"person",iconBg:"rgba(90,200,250,0.15)",iconColor:T.teal,text:"New candidate: James Okafor sourced",time:"5d ago",detail:"Marcus Webb referral. 6 YOE at Databricks. Actively looking."},
];

const STAGES=["Sourced","Screening","Interview","Offer","Placed"];
const STAGE_META={
  Sourced:{color:T.gray,bg:"rgba(142,142,147,0.12)"},
  Screening:{color:T.orange,bg:"rgba(255,149,0,0.10)"},
  Interview:{color:T.purple,bg:"rgba(175,82,222,0.10)"},
  Offer:{color:T.blue,bg:"rgba(0,122,255,0.10)"},
  Placed:{color:T.green,bg:"rgba(52,199,89,0.10)"},
};
const CLIENT_STATUS={
  Active:{color:T.green,bg:"rgba(52,199,89,0.10)"},
  Pending:{color:T.orange,bg:"rgba(255,149,0,0.10)"},
  Closed:{color:T.gray,bg:"rgba(142,142,147,0.12)"},
};

// ─── Intelligence Engine ──────────────────────────────────────────────────────
// Analyzes all app data and generates prioritized next-best-action recommendations
function useIntelligence(contacts,jobs,clients){
  return useMemo(()=>{
    const actions=[];
    const id=(()=>{let n=0;return()=>n++;})();

    // Candidate-based actions
    contacts.forEach(c=>{
      if(c.stage==="Offer"&&c.lastContactDays>=1){
        actions.push({id:id(),priority:"critical",type:"candidate",person:c.name,avatar:c.avatar,icon:"phone",iconBg:"rgba(255,59,48,0.12)",iconColor:T.red,
          title:`Follow up with ${c.name}`,subtitle:`Offer stage · ${c.lastContact} since last contact`,
          action:`Call ${c.name} to confirm offer acceptance and start date. They mentioned wanting more equity — come prepared with revised package or clear rationale.`,
          tags:["Offer","Urgent"],color:T.red});
      }
      if(c.stage==="Interview"&&c.lastContactDays>=2){
        actions.push({id:id(),priority:"high",type:"candidate",person:c.name,avatar:c.avatar,icon:"send",iconBg:"rgba(0,122,255,0.12)",iconColor:T.blue,
          title:`Prep ${c.name} for interview`,subtitle:`Interview stage · ${c.lastContact} since last contact`,
          action:`Send interview prep materials to ${c.name}. Review the JD together and coach on the specific panel format. Ask for their availability confirmation.`,
          tags:["Interview","Prep"],color:T.blue});
      }
      if(c.stage==="Screening"&&c.lastContactDays>=4){
        actions.push({id:id(),priority:"medium",type:"candidate",person:c.name,avatar:c.avatar,icon:"phone",iconBg:"rgba(255,149,0,0.12)",iconColor:T.orange,
          title:`Re-engage ${c.name}`,subtitle:`Screening · ${c.lastContact} since last contact`,
          action:`It's been ${c.lastContact} since you last spoke with ${c.name}. Check in on their job search status — candidates at screening go cold quickly. Offer to schedule the next step.`,
          tags:["Screening","Re-engage"],color:T.orange});
      }
      if(c.stage==="Sourced"&&c.lastContactDays>=3){
        actions.push({id:id(),priority:"medium",type:"candidate",person:c.name,avatar:c.avatar,icon:"mail",iconBg:"rgba(90,200,250,0.15)",iconColor:T.teal,
          title:`First outreach to ${c.name}`,subtitle:`Sourced · Not yet contacted`,
          action:`${c.name} was sourced ${c.lastContact} ago and hasn't been contacted yet. Send an introductory email referencing their ${c.tags[0]||"background"} experience. Keep it short and specific.`,
          tags:["Sourced","First Contact"],color:T.teal});
      }
      if(c.hot&&c.stage!=="Placed"&&c.stage!=="Offer"){
        actions.push({id:id(),priority:"high",type:"candidate",person:c.name,avatar:c.avatar,icon:"fire",iconBg:"rgba(255,59,48,0.10)",iconColor:T.red,
          title:`Hot lead needs attention: ${c.name}`,subtitle:`Flagged · ${c.stage} stage`,
          action:`${c.name} is flagged as a hot lead in ${c.stage}. ${c.notes} Prioritize moving them forward — every day risks them going to another opportunity or recruiter.`,
          tags:["Hot","Priority"],color:T.red});
      }
    });

    // Job-based actions
    jobs.filter(j=>j.stage==="Active"||j.stage==="Pending").forEach(job=>{
      if(job.deadlineDays<0){
        actions.push({id:id(),priority:"critical",type:"job",icon:"alert",iconBg:"rgba(255,59,48,0.12)",iconColor:T.red,
          title:`Overdue: ${job.title} at ${job.company}`,subtitle:`Deadline passed ${Math.abs(job.deadlineDays)}d ago`,
          action:`The ${job.title} role at ${job.company} deadline has passed. Contact ${job.company}'s hiring manager immediately to clarify status, extend the deadline, or understand if they've moved forward internally. ${job.candidates} candidates are in your pipeline for this role.`,
          tags:["Overdue","Critical"],color:T.red});
      } else if(job.deadlineDays<=7&&job.stage==="Active"){
        actions.push({id:id(),priority:"high",type:"job",icon:"calendar",iconBg:"rgba(255,149,0,0.12)",iconColor:T.orange,
          title:`Deadline in ${job.deadlineDays}d: ${job.title}`,subtitle:`${job.company} · ${job.candidates} candidates`,
          action:`The ${job.title} role at ${job.company} closes in ${job.deadlineDays} days. Accelerate your pipeline: schedule final interviews, send updated candidate summaries to the client, and confirm which candidates are still interested.`,
          tags:["Deadline","Urgent"],color:T.orange});
      }
      if(job.stage==="Pending"){
        actions.push({id:id(),priority:"medium",type:"job",icon:"note",iconBg:"rgba(175,82,222,0.12)",iconColor:T.purple,
          title:`Chase retainer for ${job.title}`,subtitle:`${job.company} · Pending signature`,
          action:`The ${job.title} engagement with ${job.company} is still pending a signed retainer. Follow up with the primary contact directly — offer to resend the agreement or clarify any terms. This deal shouldn't stay in limbo.`,
          tags:["Pending","Contract"],color:T.purple});
      }
    });

    // Client-based actions
    clients.filter(c=>c.status==="Active"||c.status==="Pending").forEach(client=>{
      if(client.lastOutreachDays>=5&&client.status==="Active"){
        actions.push({id:id(),priority:"medium",type:"client",person:client.name,icon:"building2",iconBg:"rgba(88,86,214,0.10)",iconColor:T.indigo,
          title:`Check in with ${client.name}`,subtitle:`${client.industry} · Last outreach ${client.lastOutreach} ago`,
          action:`It's been ${client.lastOutreach} since you last touched ${client.name}. Send a brief pipeline update to ${client.primaryContact.name} (${client.primaryContact.title}). Share any new relevant candidate profiles and reaffirm your commitment to filling their ${client.openRoles} open role${client.openRoles!==1?"s":""}. Keep the relationship warm.`,
          tags:["Check-in","Relationship"],color:T.indigo});
      }
      if(client.status==="Pending"&&client.lastOutreachDays>=3){
        actions.push({id:id(),priority:"high",type:"client",person:client.name,icon:"alert",iconBg:"rgba(255,149,0,0.12)",iconColor:T.orange,
          title:`Follow up: ${client.name} retainer`,subtitle:`Pending signature · ${client.lastOutreach} since contact`,
          action:`${client.name} has a pending engagement for ${client.openRoles} role${client.openRoles!==1?"s":""}. Contact ${client.primaryContact.name} to check on retainer status. Consider offering a brief call to discuss any blockers — closed-lost deals often die here.`,
          tags:["Pending","Follow-up"],color:T.orange});
      }
    });

    // Sort: critical → high → medium
    const order={critical:0,high:1,medium:2};
    return actions.sort((a,b)=>order[a.priority]-order[b.priority]);
  },[contacts,jobs,clients]);
}

// ─── Typography ───────────────────────────────────────────────────────────────
const sf=(size,weight=400,color=T.label)=>({
  fontFamily:"-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif",
  fontSize:size,fontWeight:weight,color,
  letterSpacing:size>=26?"-0.022em":size>=17?"-0.012em":"-0.006em",lineHeight:1.35,
});

// ─── Primitives ───────────────────────────────────────────────────────────────
function Avatar({initials,size=44}){
  const palette=[T.blue,T.purple,T.orange,T.green,T.red,T.teal,T.indigo];
  const bg=palette[((initials.charCodeAt(0)||0)+(initials.charCodeAt(1)||0))%palette.length];
  return <div style={{width:size,height:size,borderRadius:size*0.34,background:bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,...sf(size*0.33,700,"#fff")}}>{initials}</div>;
}
function LogoBadge({letters,color,size=44}){
  return <div style={{width:size,height:size,borderRadius:size*0.26,background:`${color}18`,border:`1px solid ${color}30`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,...sf(size*0.3,800,color)}}>{letters}</div>;
}
function StagePill({stage,small=false}){
  const m=STAGE_META[stage]||{color:T.gray,bg:"rgba(142,142,147,0.1)"};
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,background:m.bg,color:m.color,borderRadius:20,padding:small?"2px 9px":"4px 11px",fontSize:small?11:12,fontWeight:600,fontFamily:"-apple-system,sans-serif"}}><span style={{width:5,height:5,borderRadius:"50%",background:m.color,flexShrink:0}}/>{stage}</span>;
}
function StatusPill({status,small=false}){
  const m=CLIENT_STATUS[status]||{color:T.gray,bg:"rgba(142,142,147,0.1)"};
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,background:m.bg,color:m.color,borderRadius:20,padding:small?"2px 9px":"4px 11px",fontSize:small?11:12,fontWeight:600,fontFamily:"-apple-system,sans-serif"}}><span style={{width:5,height:5,borderRadius:"50%",background:m.color,flexShrink:0}}/>{status}</span>;
}
function Toggle({value,onChange}){
  return <div onClick={()=>onChange(!value)} className="tap" style={{width:51,height:31,borderRadius:16,background:value?T.green:T.gray4,position:"relative",flexShrink:0,transition:`background 0.22s ${T.ease}`}}><div style={{position:"absolute",top:2,left:value?22:2,width:27,height:27,borderRadius:14,background:"#fff",boxShadow:"0 2px 8px rgba(0,0,0,0.22)",transition:`left 0.22s ${T.spring}`}}/></div>;
}
function Chevron({open,size=16}){
  return <div style={{transform:open?"rotate(90deg)":"rotate(0deg)",transition:`transform 0.22s ${T.ease}`,flexShrink:0,display:"flex",alignItems:"center"}}><Icon name="chevronRight" size={size} color={T.gray4} strokeWidth={2}/></div>;
}
function GhostBtn({label,color=T.blue,icon,onPress}){
  return <button onClick={onPress} className="tap" style={{border:"none",borderRadius:9,padding:"8px 14px",gap:6,background:`${color}12`,color,...sf(13,600),cursor:"pointer",display:"inline-flex",alignItems:"center"}}>{icon&&<Icon name={icon} size={14} color={color} strokeWidth={2}/>}{label}</button>;
}
function Pill({label,color=T.gray}){
  return <span style={{background:`${color}14`,color,borderRadius:6,padding:"3px 9px",fontSize:12,fontWeight:600,fontFamily:"-apple-system,sans-serif"}}>{label}</span>;
}
function ListCard({children,style}){
  return <div style={{background:T.card,borderRadius:T.r,overflow:"hidden",border:`0.5px solid ${T.sep}`,...style}}>{children}</div>;
}
function SectionHead({title,sub,cta,onCta}){
  return <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"16px 20px 8px"}}><div><div style={{...sf(17,700,T.label)}}>{title}</div>{sub&&<div style={{...sf(12,400,T.label3),marginTop:1}}>{sub}</div>}</div>{cta&&<span className="tap" onClick={onCta} style={{...sf(14,500,T.blue),cursor:"pointer"}}>{cta}</span>}</div>;
}
function SubTabStrip({tabs,active,onChange}){
  return <div style={{display:"flex",borderBottom:`0.5px solid ${T.sep}`,background:"rgba(255,255,255,0.6)"}}>{tabs.map(t=>(<div key={t.id} className="tap" onClick={()=>onChange(t.id)} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,padding:"10px 4px",borderBottom:`2px solid ${active===t.id?T.blue:"transparent"}`,transition:"border-color 0.18s"}}><Icon name={t.icon} size={13} color={active===t.id?T.blue:T.label3} strokeWidth={1.8}/><span style={{...sf(12,active===t.id?600:400,active===t.id?T.blue:T.label3)}}>{t.label}</span></div>))}</div>;
}

// ─── KPI Item — expandable with full profile detail ──────────────────────────
function KpiItem({item,kpiColor,isOpen,onToggle}){
  return(
    <div style={{background:T.card,borderRadius:12,boxShadow:"0 1px 4px rgba(0,0,0,0.08)",flexShrink:0,overflow:"hidden"}}>
      {/* Collapsed row — title + badge, always visible */}
      <div className="tap" onClick={onToggle}
        style={{display:"flex",alignItems:"center",gap:10,padding:"11px 12px"}}>
        {item.avatar&&<Avatar initials={item.avatar} size={34}/>}
        {item.logo&&<LogoBadge letters={item.logo} color={item.logoColor} size={34}/>}
        {!item.avatar&&!item.logo&&<IconBadge name={item.icon||"briefcase"} bg={`${item.badgeColor}14`} iconColor={item.badgeColor} size={34}/>}
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{...sf(13,600,T.label)}}>{item.title}</span>
            {item.urgent&&<Icon name="alert" size={11} color={T.red} strokeWidth={1.8}/>}
          </div>
          {/* Sub only when collapsed — hide when expanded */}
          {!isOpen&&<div style={{...sf(11,400,T.label3),marginTop:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.sub}</div>}
        </div>
        <div style={{textAlign:"right",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>
          {item.value&&<div style={{...sf(12,700,kpiColor)}}>{item.value}</div>}
          <div style={{transform:isOpen?"rotate(90deg)":"rotate(0deg)",transition:`transform 0.2s ${T.ease}`,display:"flex"}}>
            <Icon name="chevronRight" size={13} color={T.gray3} strokeWidth={2}/>
          </div>
        </div>
      </div>

      {/* Expanded detail panel */}
      {isOpen&&(
        <div style={{borderTop:`0.5px solid ${T.sep}`}}>
          <div style={{padding:"10px 12px 13px",display:"flex",flexDirection:"column",gap:7}}>
            {/* Contact/Candidate detail */}
            {item.detail&&item.detail.map((row,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
                <Icon name={row.icon} size={14} color={row.color||T.label3} strokeWidth={1.7}/>
                <span style={{...sf(12,400,T.label2)}}>{row.value}</span>
              </div>
            ))}
            {/* Notes */}
            {item.notes&&<div style={{...sf(12,400,T.label2),lineHeight:1.55,paddingTop:2}}>{item.notes}</div>}
            {/* Tags */}
            {item.tags&&item.tags.length>0&&(
              <div style={{display:"flex",gap:5,flexWrap:"wrap",paddingTop:2}}>
                {item.tags.map(t=><Pill key={t} label={t} color={kpiColor}/>)}
              </div>
            )}
            {/* Status pill */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:2}}>
              <Pill label={item.badge} color={item.badgeColor}/>
              {item.value&&<span style={{...sf(13,700,kpiColor)}}>{item.value}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── KPI Floating Modal ───────────────────────────────────────────────────────
function KpiModal({kpi,contacts,jobs,clients,onClose}){
  const [openIdx,setOpenIdx]=useState(null);
  const toggle=(i)=>setOpenIdx(prev=>prev===i?null:i);

  const items=useMemo(()=>{
    if(kpi.key==="pipeline") return jobs.filter(j=>j.stage!=="Filled").map(j=>({
      title:j.title, sub:`${j.company} · Due ${j.deadline}`,
      value:j.fee, badge:j.stage, badgeColor:j.stage==="Active"?T.green:T.orange,
      icon:"briefcase", urgent:j.urgent,
      notes:j.notes,
      tags:[`${j.candidates} candidates`, j.stage],
      detail:[
        {icon:"building",value:j.company,color:T.label3},
        {icon:"calendar",value:`Due ${j.deadline}`,color:T.label3},
        {icon:"money",value:j.fee,color:T.blue},
      ],
    }));
    if(kpi.key==="clients") return clients.filter(c=>c.status==="Active").map(c=>({
      title:c.name, sub:`${c.industry} · ${c.openRoles} open role${c.openRoles!==1?"s":""}`,
      value:c.totalFees==="$0"?"—":c.totalFees, badge:c.status, badgeColor:T.green,
      logo:c.logo, logoColor:c.logoColor,
      notes:c.notes?.[0]?.text||null,
      tags:c.tags||[],
      detail:[
        {icon:"industry",value:c.industry,color:T.label3},
        {icon:"globe",value:c.website,color:T.blue},
        {icon:"people",value:`${c.employees} employees`,color:T.label3},
        {icon:"phone",value:c.primaryContact.name+" · "+c.primaryContact.title,color:T.label3},
      ],
    }));
    if(kpi.key==="hot") return contacts.filter(c=>c.hot).map(c=>({
      title:c.name, sub:`${c.title} · ${c.stage}`,
      badge:c.stage, avatar:c.avatar, badgeColor:STAGE_META[c.stage]?.color||T.gray,
      notes:c.notes,
      tags:c.tags||[],
      detail:[
        {icon:"briefcase",value:`${c.title} at ${c.company}`,color:T.label3},
        {icon:"money",value:c.salary,color:T.green},
        {icon:"phone",value:c.phone,color:T.label3},
        {icon:"mail",value:c.email,color:T.blue},
        {icon:"clock",value:`Last contact ${c.lastContact}`,color:T.label3},
      ],
    }));
    if(kpi.key==="placed") return contacts.filter(c=>c.stage==="Placed").map(c=>({
      title:c.name, sub:`${c.title} · ${c.company}`,
      value:c.salary, badge:"Placed", avatar:c.avatar, badgeColor:T.green,
      notes:c.notes,
      tags:c.tags||[],
      detail:[
        {icon:"briefcase",value:`${c.title} at ${c.company}`,color:T.label3},
        {icon:"money",value:c.salary,color:T.green},
        {icon:"mail",value:c.email,color:T.blue},
        {icon:"phone",value:c.phone,color:T.label3},
      ],
    }));
    return [];
  },[kpi,contacts,jobs,clients]);

  return(
    <div
      onClick={onClose}
      onTouchMove={e=>e.stopPropagation()}
      onWheel={e=>e.stopPropagation()}
      style={{position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",padding:"24px 20px",background:"rgba(0,0,0,0.48)",backdropFilter:"blur(6px)",touchAction:"none"}}
    >
      <div
        onClick={e=>e.stopPropagation()}
        onTouchMove={e=>e.stopPropagation()}
        className="pop-in"
        style={{background:T.bg,borderRadius:22,width:"100%",maxWidth:340,maxHeight:"70%",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 60px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.2)",touchAction:"auto"}}
      >
        {/* Coloured header */}
        <div style={{flexShrink:0,background:kpi.color,padding:"15px 14px 13px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,borderRadius:9,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <Icon name={kpi.icon} size={17} color="#fff" strokeWidth={1.9}/>
            </div>
            <div>
              <div style={{...sf(16,700,"#fff")}}>{kpi.label}</div>
              <div style={{...sf(11,400,"rgba(255,255,255,0.75)"),marginTop:1}}>{items.length} item{items.length!==1?"s":""} · tap to expand</div>
            </div>
          </div>
          <div className="tap" onClick={onClose} style={{width:26,height:26,borderRadius:13,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="dismiss" size={13} color="#fff" strokeWidth={2.4}/>
          </div>
        </div>

        {/* Scrollable accordion list */}
        <div
          onClick={e=>e.stopPropagation()}
          onTouchMove={e=>e.stopPropagation()}
          style={{flex:1,overflowY:"auto",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch",padding:"10px 12px",display:"flex",flexDirection:"column",gap:8}}
        >
          {items.map((item,i)=>(
            <KpiItem key={i} item={item} kpiColor={kpi.color} isOpen={openIdx===i} onToggle={()=>toggle(i)}/>
          ))}
          {items.length===0&&<div style={{textAlign:"center",padding:"22px 0",...sf(13,400,T.label3)}}>Nothing here yet</div>}
        </div>

        <div style={{flexShrink:0,padding:"8px 0 12px",borderTop:`0.5px solid ${T.sep}`,textAlign:"center"}}>
          <div style={{...sf(11,400,T.label3)}}>Tap outside to close</div>
        </div>
      </div>
    </div>
  );
}

// ─── NBA Action Card — accordion, one open at a time (controlled) ─────────────
function NBAActionCard({action,isOpen,onToggle,onDismiss}){
  const priorityLabel={critical:"Critical",high:"High Priority",medium:"Suggested"};
  const priorityColor={critical:T.red,high:T.orange,medium:T.blue};
  const pc=priorityColor[action.priority]||T.blue;
  return(
    <div style={{background:T.card,borderRadius:14,boxShadow:"0 1px 4px rgba(0,0,0,0.08), 0 2px 12px rgba(0,0,0,0.05)",flexShrink:0,overflow:"hidden"}}>
      {/* Thin priority accent at very top — 2px, no glow */}
      <div style={{height:2,background:pc,flexShrink:0}}/>
      {/* Collapsed header — title + priority badge only */}
      <div className="tap" onClick={onToggle}
        style={{display:"flex",alignItems:"center",gap:10,padding:"11px 13px"}}>
        <IconBadge name={action.icon} bg={action.iconBg} iconColor={action.iconColor} size={34}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{marginBottom:4}}>
            <span style={{background:`${pc}14`,color:pc,borderRadius:4,padding:"1px 7px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em"}}>{priorityLabel[action.priority]}</span>
          </div>
          <div style={{...sf(13,600,T.label),lineHeight:1.35,paddingRight:4}}>{action.title}</div>
        </div>
        <div style={{transform:isOpen?"rotate(90deg)":"rotate(0deg)",transition:`transform 0.2s ${T.ease}`,flexShrink:0,display:"flex",alignItems:"center"}}>
          <Icon name="chevronRight" size={14} color={T.gray3} strokeWidth={2}/>
        </div>
      </div>
      {/* Expanded detail — no colored borders, just clean card */}
      {isOpen&&(
        <div style={{borderTop:`0.5px solid ${T.sep}`}}>
          <div style={{padding:"12px 13px 14px"}}>
            <div style={{...sf(11,400,T.label3),marginBottom:10}}>{action.subtitle}</div>
            {/* Recommended action — plain drop-shadow box, no left border */}
            <div style={{background:T.bg,borderRadius:10,padding:"10px 12px",boxShadow:"0 1px 4px rgba(0,0,0,0.07)"}}>
              <div style={{...sf(10,700,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>Recommended Action</div>
              <div style={{...sf(13,400,T.label2),lineHeight:1.65}}>{action.action}</div>
            </div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:12,alignItems:"center"}}>
              {action.tags.map(tag=><Pill key={tag} label={tag} color={T.gray}/>)}
              <button onClick={e=>{e.stopPropagation();onDismiss(action.id);}} className="tap"
                style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,border:"none",background:`${T.green}14`,borderRadius:8,padding:"6px 11px",color:T.green,...sf(12,600),cursor:"pointer"}}>
                <Icon name="check" size={12} color={T.green} strokeWidth={2.2}/>Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── NBA Modal — centered floating card, same pattern as KpiModal ─────────────
function NBAModal({actions,onClose,onDismiss}){
  const [openId,setOpenId]=useState(null);
  const toggle=(id)=>setOpenId(prev=>prev===id?null:id);

  return(
    <div
      onClick={onClose}
      onTouchMove={e=>e.stopPropagation()}
      onWheel={e=>e.stopPropagation()}
      style={{position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",padding:"24px 20px",background:"rgba(0,0,0,0.48)",backdropFilter:"blur(6px)",touchAction:"none"}}
    >
      <div
        onClick={e=>e.stopPropagation()}
        onTouchMove={e=>e.stopPropagation()}
        className="pop-in"
        style={{background:T.bg,borderRadius:22,width:"100%",maxWidth:340,maxHeight:"72%",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 60px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.2)",touchAction:"auto"}}
      >
        {/* Gradient header — fixed, never scrolls */}
        <div style={{flexShrink:0,background:"linear-gradient(135deg,#007AFF 0%,#AF52DE 100%)",padding:"15px 14px 13px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,borderRadius:9,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <Icon name="sparkle" size={17} color="#fff" strokeWidth={1.9}/>
            </div>
            <div>
              <div style={{...sf(16,700,"#fff")}}>AI Recommendations</div>
              <div style={{...sf(11,400,"rgba(255,255,255,0.75)"),marginTop:1}}>{actions.length} action{actions.length!==1?"s":""} · tap to expand</div>
            </div>
          </div>
          <div className="tap" onClick={onClose} style={{width:26,height:26,borderRadius:13,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="dismiss" size={13} color="#fff" strokeWidth={2.4}/>
          </div>
        </div>

        {/* Scrollable action card list — contained, doesn't bleed to background */}
        <div
          onTouchMove={e=>{e.stopPropagation();}}
          onClick={e=>e.stopPropagation()}
          style={{flex:1,overflowY:"auto",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch",padding:"10px 12px",display:"flex",flexDirection:"column",gap:8}}
        >
          {actions.map(a=>(
            <NBAActionCard
              key={a.id}
              action={a}
              isOpen={openId===a.id}
              onToggle={()=>toggle(a.id)}
              onDismiss={onDismiss}
            />
          ))}
          {actions.length===0&&(
            <div style={{textAlign:"center",padding:"28px 0",display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
              <IconBadge name="checkCircle" bg="rgba(52,199,89,0.1)" iconColor={T.green} size={52}/>
              <div style={{...sf(15,600,T.label)}}>All caught up!</div>
              <div style={{...sf(12,400,T.label3),lineHeight:1.5}}>No pending actions. Great work.</div>
            </div>
          )}
        </div>

        {/* Footer hint — fixed at bottom */}
        <div style={{flexShrink:0,padding:"8px 0 12px",borderTop:`0.5px solid ${T.sep}`,textAlign:"center"}}>
          <div style={{...sf(11,400,T.label3)}}>Tap outside to close</div>
        </div>
      </div>
    </div>
  );
}

// ─── Expandable Cards ─────────────────────────────────────────────────────────
function ExpandableJobCard({job,setJobs,last}){
  const [open,setOpen]=useState(false);const [tab,setTab]=useState("details");
  const [editing,setEditing]=useState(false);const [draft,setDraft]=useState({...job});
  const save=()=>{setJobs(p=>p.map(j=>j.id===job.id?draft:j));setEditing(false);};
  const TABS=[{id:"details",label:"Details",icon:"note"},{id:"description",label:"JD",icon:"description"}];
  return(
    <div style={{borderBottom:last&&!open?"none":`0.5px solid ${T.sep}`}}>
      <div className="tap" onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",background:T.card}}>
        <IconBadge name={job.urgent?"alert":"briefcase"} bg={job.urgent?"rgba(255,59,48,0.10)":"rgba(0,122,255,0.08)"} iconColor={job.urgent?T.red:T.blue} size={38}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{...sf(15,600,T.label)}}>{job.title}</div>
          <div style={{...sf(13,400,T.label3),marginTop:2}}>{job.company} · Due {job.deadline}</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0,marginRight:6}}>
          <div style={{...sf(15,700,T.blue)}}>{job.fee}</div>
          <div style={{...sf(12,400,T.label3),marginTop:1}}>{job.candidates} candidates</div>
        </div>
        <Chevron open={open}/>
      </div>
      {open&&(
        <div className="expand" style={{background:"#F8F8FA",borderTop:`0.5px solid ${T.sep}`}}>
          <SubTabStrip tabs={TABS} active={tab} onChange={setTab}/>
          <div style={{padding:"14px 16px 4px"}}>
            {tab==="details"&&(editing?(
              <>
                {[{k:"title",l:"Title"},{k:"company",l:"Company"},{k:"fee",l:"Fee"},{k:"deadline",l:"Deadline"}].map(f=>(
                  <div key={f.k} style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>{f.l}</div><input value={draft[f.k]} onChange={e=>setDraft(d=>({...d,[f.k]:e.target.value}))} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(15),outline:"none"}}/></div>
                ))}
                <div style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>Notes</div><textarea value={draft.notes} onChange={e=>setDraft(d=>({...d,notes:e.target.value}))} rows={2} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(14,400,T.label),outline:"none",resize:"none",lineHeight:1.5}}/></div>
                <div style={{marginBottom:14}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>Status</div><div style={{display:"flex",gap:7}}>{["Active","Pending","Filled"].map(s=>(<div key={s} className="tap" onClick={()=>setDraft(d=>({...d,stage:s}))} style={{borderRadius:20,padding:"6px 14px",...sf(13,draft.stage===s?600:400,draft.stage===s?"#fff":T.gray),background:draft.stage===s?T.blue:T.gray5,transition:"all 0.18s"}}>{s}</div>))}</div></div>
              </>
            ):(
              <div style={{paddingBottom:10}}>
                <div style={{...sf(13,400,T.label2),lineHeight:1.6,marginBottom:10}}>{job.notes}</div>
                <div style={{display:"flex",gap:7,flexWrap:"wrap"}}><Pill label={`${job.candidates} candidates`} color={T.blue}/><Pill label={job.stage} color={job.stage==="Active"?T.green:job.stage==="Filled"?T.gray:T.orange}/>{job.urgent&&<Pill label="Urgent" color={T.red}/>}</div>
              </div>
            ))}
            {tab==="description"&&(
              <div style={{paddingBottom:10}}>
                {editing?<textarea value={draft.description||""} onChange={e=>setDraft(d=>({...d,description:e.target.value}))} rows={12} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"10px 12px",...sf(14,400,T.label),outline:"none",resize:"vertical",lineHeight:1.65,minHeight:160}}/>
                :<div style={{...sf(13,400,T.label2),lineHeight:1.7,whiteSpace:"pre-wrap"}}>{job.description||<span style={{color:T.label3,fontStyle:"italic"}}>No job description added yet.</span>}</div>}
              </div>
            )}
            <div style={{display:"flex",gap:8,paddingBottom:14}}>
              <GhostBtn label={editing?"Save Changes":"Edit"} icon={editing?"check":"edit"} color={T.blue} onPress={editing?save:()=>setEditing(true)}/>
              {editing&&<GhostBtn label="Cancel" color={T.gray} onPress={()=>{setDraft({...job});setEditing(false);}}/>}
              {!editing&&(
                <button onClick={()=>{if(window.confirm(`Delete "${job.title}"? This cannot be undone.`))setJobs(p=>p.filter(j=>j.id!==job.id));}}
                  className="tap"
                  style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,border:"none",background:`${T.red}10`,borderRadius:9,padding:"7px 12px",color:T.red,...sf(13,600),cursor:"pointer"}}>
                  <Icon name="trash" size={13} color={T.red} strokeWidth={2}/>Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BD Pitch Generator (calls Anthropic API) ─────────────────────────────────
async function generateBDPitch(contact, resume) {
  const expList = (resume.experience||[]).map(e=>`${e.role} at ${e.company} (${e.period}): ${e.notes}`).join("\n");
  const prompt = `You are an expert recruiting business development assistant. Based on this candidate's resume, generate a "Hot-Pitch Email" that a recruiter can send to client companies to pitch this candidate.

CANDIDATE PROFILE:
Name: ${contact.name}
Current Title: ${contact.title}
Current Company: ${contact.company}
Target Salary: ${contact.salary}
Phone: ${contact.phone}
Email: ${contact.email}

RESUME SUMMARY:
${resume.summary}

EXPERIENCE:
${expList}

EDUCATION:
${resume.education||"Not specified"}

TAGS/SKILLS:
${(contact.tags||[]).join(", ")}

Generate the pitch using EXACTLY this format:

SUBJECT: [Employment Type] ${contact.title} ([X]+ yrs exp) - For [Client Company Name]

Hi [Contact Name],

I am representing a [X]-year [job title] who is [relocation/availability context] and looking for a new, [employment type] position.

[He/She/They] brings [X] years of [industry/specialty] experience with a strong [niche focus] foundation, having worked across [company/setting types] and diverse [client/customer] populations. Most recently, [he/she/they] has been [brief description of most recent role], and is known for [1 standout soft skill or measurable trait].

A few quick highlights:
• [Degree or Certification] – [Institution]
• Prior experience with [Employer 1] and [Employer 2]
• [Key skill or technical strength #1]
• [Relevant geographic, industry, or personal connection if applicable]
• [Licensure, certification, or clearance if relevant]
• Available for interviews [placeholder]

[He/She/They] is actively exploring new opportunities and highly motivated to secure the right fit quickly.

Let me know if you'd like to see [his/her/their] resume.

INSTRUCTIONS:
- Infer years of experience from resume dates
- Auto-detect industry from resume context (tech, finance, healthcare, etc.) — do NOT use healthcare language for non-healthcare candidates
- Use warm, confident third-person recruiter voice — NOT robotic
- Bullet points must be punchy and one line each
- If gender pronouns unclear from name, use They/Them
- Leave [Client Company Name] and [Contact Name] as editable placeholders
- Pre-fill everything else you can determine from the resume
- Return ONLY the email text, nothing else`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model:"claude-sonnet-4-20250514",
      max_tokens:1000,
      messages:[{role:"user",content:prompt}]
    })
  });
  const data = await response.json();
  return data.content?.map(b=>b.text||"").join("").trim() || "";
}

function ExpandableContactCard({contact,setContacts,last,gmail}){
  const [open,setOpen]=useState(false);const [tab,setTab]=useState("profile");
  const [editing,setEditing]=useState(false);const [resumeOpen,setResumeOpen]=useState(true);
  const [draft,setDraft]=useState({...contact});
  const [resumeDraft,setResumeDraft]=useState(contact.resume||{summary:"",experience:[],education:"",linkedIn:""});
  const [editingResume,setEditingResume]=useState(false);
  // BD Pitch state
  const [bdPitch,setBdPitch]=useState(contact.bdPitch||"");
  const [editingPitch,setEditingPitch]=useState(false);
  const [pitchDraft,setPitchDraft]=useState("");
  const [generating,setGenerating]=useState(false);
  const [copied,setCopied]=useState(false);
  const [generateError,setGenerateError]=useState("");

  const hasResume=!!(contact.resume?.summary);
  const hasPitch=!!bdPitch;

  const persistPitch=(pitch)=>{
    setBdPitch(pitch);
    setContacts(p=>p.map(c=>c.id===contact.id?{...c,bdPitch:pitch}:c));
  };

  const runGenerate=async(resumeData)=>{
    setGenerating(true);setGenerateError("");
    try{
      const pitch=await generateBDPitch(contact,resumeData);
      persistPitch(pitch);
      setTab("bdpitch");
    }catch(e){
      setGenerateError("Generation failed. Check your connection and try again.");
    }finally{setGenerating(false);}
  };

  const copyToClipboard=()=>{
    navigator.clipboard?.writeText(bdPitch).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
  };

  const save=()=>{
    const updatedResume=resumeDraft;
    setContacts(p=>p.map(c=>c.id===contact.id?{...draft,resume:updatedResume,bdPitch}:c));
    setEditing(false);setEditingResume(false);
    // Auto-generate pitch when resume is saved for the first time or updated
    if(updatedResume.summary){
      runGenerate(updatedResume);
    }
  };
  const cancel=()=>{setDraft({...contact});setResumeDraft(contact.resume||{summary:"",experience:[],education:"",linkedIn:""});setEditing(false);setEditingResume(false);};

  const TABS=[
    {id:"profile",label:"Profile",icon:"person"},
    {id:"resume", label:"Resume", icon:"resume"},
    {id:"bdpitch",label:"BD Pitch",icon:"send"},
  ];

  return(
    <div style={{borderBottom:last&&!open?"none":`0.5px solid ${T.sep}`}}>
      <div className="tap" onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:T.card}}>
        <Avatar initials={contact.avatar} size={44}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{...sf(15,600,T.label)}}>{contact.name}</span>{contact.hot&&<Icon name="fire" size={14} color={T.red} strokeWidth={1.6}/>}</div>
          <div style={{...sf(13,400,T.label3),marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{contact.title} · {contact.company}</div>
        </div>
        <div style={{flexShrink:0,textAlign:"right",marginRight:6}}>
          <StagePill stage={contact.stage} small/>
          {hasPitch&&<div style={{...sf(10,600,T.purple),marginTop:3,textAlign:"right"}}>✦ Pitch ready</div>}
          {!hasPitch&&<div style={{...sf(11,400,T.label3),marginTop:4}}>{contact.lastContact}</div>}
        </div>
        <Chevron open={open}/>
      </div>
      {open&&(
        <div className="expand" style={{background:"#F8F8FA",borderTop:`0.5px solid ${T.sep}`}}>
          <SubTabStrip tabs={TABS} active={tab} onChange={setTab}/>

          {/* ── PROFILE TAB ── */}
          {tab==="profile"&&(
            <div style={{padding:"14px 16px 4px"}}>
              {editing?(
                <>
                  {[{k:"title",l:"Title"},{k:"company",l:"Company"},{k:"email",l:"Email"},{k:"phone",l:"Phone"},{k:"salary",l:"Salary"}].map(f=>(<div key={f.k} style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>{f.l}</div><input value={draft[f.k]||""} onChange={e=>setDraft(d=>({...d,[f.k]:e.target.value}))} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(15),outline:"none"}}/></div>))}
                  <div style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>Notes</div><textarea value={draft.notes||""} onChange={e=>setDraft(d=>({...d,notes:e.target.value}))} rows={2} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(14,400,T.label),outline:"none",resize:"none",lineHeight:1.5}}/></div>
                  <div style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>Stage</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{STAGES.map(s=>(<div key={s} className="tap" onClick={()=>setDraft(d=>({...d,stage:s}))} style={{borderRadius:20,padding:"5px 12px",...sf(12,draft.stage===s?600:400,draft.stage===s?"#fff":T.gray),background:draft.stage===s?STAGE_META[s].color:T.gray5,transition:"all 0.18s"}}>{s}</div>))}</div></div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}><div style={{display:"flex",alignItems:"center",gap:8}}><Icon name="fire" size={16} color={T.red} strokeWidth={1.6}/><span style={{...sf(14,400,T.label)}}>Hot Lead</span></div><Toggle value={draft.hot} onChange={v=>setDraft(d=>({...d,hot:v}))}/></div>
                </>
              ):(
                <div style={{paddingBottom:10}}>
                  {/* Contact info rows — phone is tappable to call, email opens compose */}
                  {[
                    {icon:"phone",v:contact.phone,color:T.green, href:`tel:${contact.phone}`},
                    {icon:"mail", v:contact.email,color:T.blue,  href:null},
                    {icon:"money",v:contact.salary,color:T.orange,href:null},
                    {icon:"clock",v:`Last contact ${contact.lastContact}`,color:T.gray,href:null},
                  ].map(r=>(
                    r.href
                      ? <a key={r.v} href={r.href} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 0",borderBottom:`0.5px solid ${T.sep}`,textDecoration:"none"}}>
                          <Icon name={r.icon} size={16} color={r.color} strokeWidth={1.6}/>
                          <span style={{...sf(13,400,r.color)}}>{r.v}</span>
                        </a>
                      : <div key={r.v} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 0",borderBottom:`0.5px solid ${T.sep}`}}>
                          <Icon name={r.icon} size={16} color={r.color} strokeWidth={1.6}/>
                          <span style={{...sf(13,400,T.label2)}}>{r.v}</span>
                        </div>
                  ))}
                  <div style={{...sf(13,400,T.label2),lineHeight:1.6,marginTop:10,marginBottom:8}}>{contact.notes}</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{contact.tags.map(t=><Pill key={t} label={t} color={T.blue}/>)}</div>
                  {/* Gmail email thread */}
                  {gmail?.gmailUser&&(
                    <div style={{marginTop:4}}>
                      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8}}>
                        <div style={{width:16,height:16,borderRadius:4,background:"#EA4335",display:"flex",alignItems:"center",justifyContent:"center"}}>
                          <Icon name="mail" size={9} color="#fff" strokeWidth={2}/>
                        </div>
                        <span style={{...sf(11,700,T.label3),textTransform:"uppercase",letterSpacing:"0.07em"}}>Gmail Emails</span>
                        {gmail.lastSync&&<span style={{...sf(10,400,T.label3),marginLeft:"auto"}}>Updated {gmail.lastSync.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
                      </div>
                      <GmailThreadView emails={contact.gmailEmails} contactName={contact.name}/>
                    </div>
                  )}
                </div>
              )}
              <div style={{display:"flex",gap:8,paddingBottom:14,flexWrap:"wrap",alignItems:"center"}}>
                <GhostBtn label={editing?"Save":"Edit Profile"} icon={editing?"check":"edit"} color={T.blue} onPress={editing?save:()=>setEditing(true)}/>
                {!editing&&(
                  <a href={`tel:${contact.phone}`} style={{textDecoration:"none"}}>
                    <GhostBtn label="Call" icon="phone" color={T.green} onPress={()=>{}}/>
                  </a>
                )}
                {!editing&&<GhostBtn label="Email" icon="mail" color={T.blue} onPress={()=>gmail?.openCompose({email:contact.email,name:contact.name,subject:`Following up — ${contact.name}`,body:"Hi,\n\n"})}/>}
                {editing&&<GhostBtn label="Cancel" color={T.gray} onPress={cancel}/>}
                {/* Inline Hot Lead toggle — no need to enter edit mode */}
                {!editing&&(
                  <div className="tap" onClick={()=>setContacts(p=>p.map(c=>c.id===contact.id?{...c,hot:!c.hot}:c))}
                    style={{display:"flex",alignItems:"center",gap:5,borderRadius:9,padding:"7px 11px",background:contact.hot?"rgba(255,59,48,0.10)":"rgba(142,142,147,0.10)",border:`0.5px solid ${contact.hot?T.red:T.gray4}`}}>
                    <Icon name="fire" size={14} color={contact.hot?T.red:T.gray3} strokeWidth={contact.hot?2:1.6}/>
                    <span style={{...sf(12,600,contact.hot?T.red:T.gray)}}>{contact.hot?"Hot":"Mark Hot"}</span>
                  </div>
                )}
                {!editing&&(
                  <button onClick={()=>{if(window.confirm(`Delete ${contact.name}? This cannot be undone.`))setContacts(p=>p.filter(c=>c.id!==contact.id));}}
                    className="tap"
                    style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,border:"none",background:`${T.red}10`,borderRadius:9,padding:"7px 12px",color:T.red,...sf(13,600),cursor:"pointer"}}>
                    <Icon name="trash" size={13} color={T.red} strokeWidth={2}/>Delete
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── RESUME TAB ── */}
          {tab==="resume"&&(
            <div style={{padding:"14px 16px 4px"}}>
              {!hasResume&&!editingResume?(
                <div style={{textAlign:"center",padding:"20px 0 16px"}}>
                  <IconBadge name="resume" bg="rgba(0,122,255,0.08)" iconColor={T.blue} size={52}/>
                  <div style={{...sf(15,600,T.label),marginTop:12}}>No Resume Added</div>
                  <div style={{...sf(13,400,T.label3),marginTop:4,marginBottom:6,lineHeight:1.5}}>Add candidate background, experience, and education.</div>
                  <div style={{...sf(12,400,T.purple),marginBottom:16,lineHeight:1.4}}>✦ A BD Pitch email will be auto-generated when you save the resume.</div>
                  <GhostBtn label="Add Resume" icon="upload" color={T.blue} onPress={()=>setEditingResume(true)}/>
                </div>
              ):editingResume?(
                <div>
                  <div style={{background:"rgba(175,82,222,0.06)",borderRadius:9,padding:"10px 12px",marginBottom:12,display:"flex",alignItems:"flex-start",gap:8}}>
                    <Icon name="sparkle" size={14} color={T.purple} strokeWidth={1.8}/>
                    <div style={{...sf(12,400,T.purple),lineHeight:1.5}}>A personalized BD Pitch email will be auto-generated when you save this resume.</div>
                  </div>
                  <div style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>Summary</div><textarea value={resumeDraft.summary} onChange={e=>setResumeDraft(d=>({...d,summary:e.target.value}))} rows={3} placeholder="Professional summary…" style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"10px 12px",...sf(14,400,T.label),outline:"none",resize:"none",lineHeight:1.6}}/></div>
                  {(resumeDraft.experience||[]).map((exp,i)=>(<div key={i} style={{background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"10px 12px",marginBottom:9}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><div style={{...sf(12,600,T.label3),textTransform:"uppercase",letterSpacing:"0.06em"}}>Experience {i+1}</div><div className="tap" onClick={()=>setResumeDraft(d=>({...d,experience:d.experience.filter((_,j)=>j!==i)}))}><Icon name="trash" size={14} color={T.red} strokeWidth={1.8}/></div></div>{[{k:"role",ph:"Role"},{k:"company",ph:"Company"},{k:"period",ph:"Period"}].map(f=>(<input key={f.k} value={exp[f.k]||""} placeholder={f.ph} onChange={e=>setResumeDraft(d=>({...d,experience:d.experience.map((x,j)=>j===i?{...x,[f.k]:e.target.value}:x)}))} style={{width:"100%",border:"none",borderBottom:`0.5px solid ${T.sep}`,outline:"none",...sf(13,400,T.label),background:"transparent",padding:"5px 0",marginBottom:4}}/>))}<textarea value={exp.notes||""} placeholder="Key achievements…" onChange={e=>setResumeDraft(d=>({...d,experience:d.experience.map((x,j)=>j===i?{...x,notes:e.target.value}:x)}))} rows={2} style={{width:"100%",border:"none",outline:"none",...sf(13,400,T.label2),background:"transparent",resize:"none",padding:"6px 0 0",lineHeight:1.5}}/></div>))}
                  <div className="tap" onClick={()=>setResumeDraft(d=>({...d,experience:[...(d.experience||[]),{role:"",company:"",period:"",notes:""}]}))} style={{display:"flex",alignItems:"center",gap:7,padding:"8px 0",marginBottom:11}}><Icon name="plus" size={16} color={T.blue} strokeWidth={2}/><span style={{...sf(14,500,T.blue)}}>Add Experience</span></div>
                  <div style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>Education</div><input value={resumeDraft.education||""} onChange={e=>setResumeDraft(d=>({...d,education:e.target.value}))} placeholder="Degree, School, Year" style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(15),outline:"none"}}/></div>
                  <div style={{marginBottom:14}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>LinkedIn</div><input value={resumeDraft.linkedIn||""} onChange={e=>setResumeDraft(d=>({...d,linkedIn:e.target.value}))} placeholder="linkedin.com/in/name" style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(15),outline:"none"}}/></div>
                </div>
              ):(
                <div style={{paddingBottom:6}}>
                  <div className="tap" onClick={()=>setResumeOpen(o=>!o)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:T.card,borderRadius:10,padding:"10px 14px",marginBottom:10,border:`0.5px solid ${T.sep}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}><Icon name="resume" size={16} color={T.blue} strokeWidth={1.6}/><span style={{...sf(14,600,T.label)}}>Full Resume</span></div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{...sf(12,400,T.label3)}}>{resumeOpen?"Collapse":"Expand"}</span><Icon name={resumeOpen?"collapse":"expand"} size={14} color={T.label3} strokeWidth={1.8}/></div>
                  </div>
                  {resumeOpen&&<div className="expand">
                    <div style={{marginBottom:10}}><div style={{...sf(10,700,T.label3),textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>Summary</div><div style={{...sf(13,400,T.label2),lineHeight:1.65}}>{contact.resume.summary}</div></div>
                    {(contact.resume.experience||[]).map((exp,i)=>(<div key={i} style={{marginBottom:8}}><div style={{display:"flex",justifyContent:"space-between"}}><span style={{...sf(13,600,T.label)}}>{exp.role}</span><span style={{...sf(11,400,T.label3)}}>{exp.period}</span></div><div style={{...sf(12,500,T.blue)}}>{exp.company}</div><div style={{...sf(12,400,T.label3),marginTop:3,lineHeight:1.5}}>{exp.notes}</div></div>))}
                    {contact.resume.education&&<div style={{marginTop:8,...sf(13,400,T.label2)}}><span style={{...sf(10,700,T.label3),textTransform:"uppercase",letterSpacing:"0.08em",marginRight:8}}>Education</span>{contact.resume.education}</div>}
                    {contact.resume.linkedIn&&<div style={{display:"flex",alignItems:"center",gap:7,marginTop:8}}><Icon name="link" size={13} color={T.blue} strokeWidth={1.8}/><span style={{...sf(12,400,T.blue)}}>{contact.resume.linkedIn}</span></div>}
                  </div>}
                </div>
              )}
              <div style={{display:"flex",gap:8,paddingBottom:14,flexWrap:"wrap"}}>
                {editingResume
                  ?<><GhostBtn label={generating?"Saving & Generating…":"Save & Generate Pitch"} icon={generating?"sparkle":"check"} color={T.purple} onPress={save}/><GhostBtn label="Cancel" color={T.gray} onPress={cancel}/></>
                  :hasResume?<GhostBtn label="Edit Resume" icon="edit" color={T.blue} onPress={()=>setEditingResume(true)}/>
                  :null
                }
              </div>
            </div>
          )}

          {/* ── BD PITCH TAB ── */}
          {tab==="bdpitch"&&(
            <div style={{padding:"14px 16px 4px"}}>
              {generating&&(
                <div style={{textAlign:"center",padding:"28px 0"}}>
                  <div style={{width:44,height:44,borderRadius:14,background:"linear-gradient(135deg,#007AFF,#AF52DE)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px"}}>
                    <Icon name="sparkle" size={22} color="#fff" strokeWidth={2}/>
                  </div>
                  <div style={{...sf(15,600,T.label)}}>Generating BD Pitch…</div>
                  <div style={{...sf(12,400,T.label3),marginTop:5,lineHeight:1.5}}>Analyzing resume and crafting your recruiter pitch email.</div>
                </div>
              )}

              {!generating&&!hasPitch&&!generateError&&(
                <div style={{textAlign:"center",padding:"20px 0 16px"}}>
                  <div style={{width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,rgba(0,122,255,0.12),rgba(175,82,222,0.12))",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px"}}>
                    <Icon name="send" size={22} color={T.purple} strokeWidth={1.8}/>
                  </div>
                  <div style={{...sf(15,600,T.label)}}>No Pitch Generated Yet</div>
                  <div style={{...sf(12,400,T.label3),marginTop:4,marginBottom:16,lineHeight:1.5}}>
                    {hasResume?"Click Generate to create your BD pitch email.":"Add a resume first, then generate the pitch."}
                  </div>
                  {hasResume&&<GhostBtn label="Generate Pitch" icon="sparkle" color={T.purple} onPress={()=>runGenerate(contact.resume)}/>}
                  {!hasResume&&<GhostBtn label="Go to Resume Tab" icon="resume" color={T.blue} onPress={()=>setTab("resume")}/>}
                </div>
              )}

              {!generating&&generateError&&(
                <div style={{background:"rgba(255,59,48,0.06)",borderRadius:10,padding:"12px",marginBottom:12}}>
                  <div style={{...sf(13,500,T.red),lineHeight:1.5}}>{generateError}</div>
                  {hasResume&&<div style={{marginTop:10}}><GhostBtn label="Try Again" icon="sparkle" color={T.red} onPress={()=>runGenerate(contact.resume)}/></div>}
                </div>
              )}

              {!generating&&hasPitch&&(
                <div>
                  {/* AI badge */}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:7}}>
                      <div style={{width:22,height:22,borderRadius:6,background:"linear-gradient(135deg,#007AFF,#AF52DE)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <Icon name="sparkle" size={11} color="#fff" strokeWidth={2}/>
                      </div>
                      <span style={{...sf(12,600,T.label)}}>AI-Generated Pitch</span>
                    </div>
                    <div style={{...sf(11,400,T.label3)}}>Review before sending</div>
                  </div>

                  {/* Pitch body — editable or readonly */}
                  {editingPitch?(
                    <textarea
                      value={pitchDraft}
                      onChange={e=>setPitchDraft(e.target.value)}
                      autoFocus
                      rows={14}
                      style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:10,padding:"12px",lineHeight:1.7,...sf(13,400,T.label),outline:"none",resize:"vertical",minHeight:200}}
                    />
                  ):(
                    <div style={{background:T.card,borderRadius:10,padding:"12px",border:`0.5px solid ${T.sep}`,whiteSpace:"pre-wrap",...sf(13,400,T.label2),lineHeight:1.75}}>
                      {bdPitch}
                    </div>
                  )}

                  {/* Action row */}
                  <div style={{display:"flex",gap:7,marginTop:12,flexWrap:"wrap",paddingBottom:14}}>
                    {editingPitch?(
                      <>
                        <GhostBtn label="Save" icon="check" color={T.blue} onPress={()=>{persistPitch(pitchDraft);setEditingPitch(false);}}/>
                        <GhostBtn label="Cancel" color={T.gray} onPress={()=>setEditingPitch(false)}/>
                      </>
                    ):(
                      <>
                        <button className="tap" onClick={copyToClipboard}
                          style={{display:"flex",alignItems:"center",gap:5,border:"none",borderRadius:9,padding:"8px 14px",background:copied?"rgba(52,199,89,0.12)":"rgba(0,122,255,0.10)",color:copied?T.green:T.blue,...sf(13,600),cursor:"pointer"}}>
                          <Icon name={copied?"check":"note"} size={14} color={copied?T.green:T.blue} strokeWidth={2}/>
                          {copied?"Copied!":"Copy"}
                        </button>
                        {gmail?.gmailUser&&(
                          <button className="tap" onClick={()=>{
                            const lines=bdPitch.split("\n");
                            const subjectLine=lines.find(l=>l.startsWith("SUBJECT:"))||"";
                            const subject=subjectLine.replace(/^SUBJECT:\s*/,"");
                            const body=lines.slice(lines.findIndex(l=>l.startsWith("SUBJECT:"))+2).join("\n");
                            gmail.openCompose({email:"",name:"",subject,body});
                          }}
                            style={{display:"flex",alignItems:"center",gap:5,border:"none",borderRadius:9,padding:"8px 14px",background:"rgba(234,67,53,0.10)",color:"#EA4335",...sf(13,600),cursor:"pointer"}}>
                            <Icon name="send" size={14} color="#EA4335" strokeWidth={2}/>Send via Gmail
                          </button>
                        )}
                        <GhostBtn label="Edit" icon="edit" color={T.blue} onPress={()=>{setPitchDraft(bdPitch);setEditingPitch(true);}}/>
                        <GhostBtn label="Regenerate" icon="sparkle" color={T.purple} onPress={()=>{if(hasResume)runGenerate(contact.resume);}}/>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExpandableActivityCard({act,setActivities,last}){
  const [open,setOpen]=useState(false);const [editing,setEditing]=useState(false);
  const [text,setText]=useState(act.text);const [detail,setDetail]=useState(act.detail);
  const save=()=>{setActivities(p=>p.map(a=>a.id===act.id?{...a,text,detail}:a));setEditing(false);};
  return(
    <div style={{borderBottom:last&&!open?"none":`0.5px solid ${T.sep}`}}>
      <div className="tap" onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"13px 16px",background:T.card}}>
        <IconBadge name={act.iconName} bg={act.iconBg} iconColor={act.iconColor} size={36}/>
        <div style={{flex:1}}><div style={{...sf(14,400,T.label),lineHeight:1.4}}>{act.text}</div><div style={{...sf(12,400,T.label3),marginTop:3}}>{act.time}</div></div>
        <Chevron open={open}/>
      </div>
      {open&&<div className="expand" style={{background:"#F8F8FA",borderTop:`0.5px solid ${T.sep}`}}><div style={{padding:"14px 16px"}}>
        {editing?(<><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>Title</div><input value={text} onChange={e=>setText(e.target.value)} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(15),outline:"none",marginBottom:12}}/><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>Details</div><textarea value={detail} onChange={e=>setDetail(e.target.value)} rows={3} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(14,400,T.label),outline:"none",resize:"none",lineHeight:1.6}}/></>)
        :<div style={{...sf(13,400,T.label2),lineHeight:1.65}}>{act.detail}</div>}
        <div style={{display:"flex",gap:8,marginTop:12}}><GhostBtn label={editing?"Save":"Edit Note"} icon={editing?"check":"edit"} color={T.blue} onPress={editing?save:()=>setEditing(true)}/>{editing&&<GhostBtn label="Cancel" color={T.gray} onPress={()=>{setText(act.text);setDetail(act.detail);setEditing(false);}}/>}</div>
      </div></div>}
    </div>
  );
}

// ─── Client Mini-Modal (Fees / Open Roles drill-down) ────────────────────────
// Uses a portal-style fixed overlay so it escapes the expanded card's stacking context.
// We attach it to document.getElementById('phone-frame') via a wrapper trick:
// Since we can't use ReactDOM.createPortal easily here, we position it fixed
// and rely on the phone frame's clip — the phone frame has overflow:hidden which clips it.
// Instead, we render it absolutely relative to the nearest positioned ancestor
// that IS the phone frame. To achieve this, we render it in the App root modal zone.
// However since ClientCard is deep in the tree, we lift the mini-modal to the Clients/ClientCard
// parent via a prop callback. For simplicity and correctness, we render the backdrop
// as a fixed overlay with a very high z-index.
function ClientMiniModal({modal,onClose}){
  const [openIdx,setOpenIdx]=useState(null);
  const toggle=(i)=>setOpenIdx(p=>p===i?null:i);
  return(
    <div
      onClick={onClose}
      onTouchMove={e=>e.stopPropagation()}
      onWheel={e=>e.stopPropagation()}
      style={{
        position:"fixed",inset:0,zIndex:900,
        display:"flex",alignItems:"center",justifyContent:"center",
        padding:"24px 20px",
        background:"rgba(0,0,0,0.48)",backdropFilter:"blur(6px)",
        touchAction:"none",
      }}
    >
      <div
        onClick={e=>e.stopPropagation()}
        onTouchMove={e=>e.stopPropagation()}
        className="pop-in"
        style={{
          background:T.bg,borderRadius:22,width:"100%",maxWidth:340,maxHeight:"68%",
          overflow:"hidden",display:"flex",flexDirection:"column",
          boxShadow:"0 24px 60px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.2)",
          touchAction:"auto",
        }}
      >
        {/* Coloured header */}
        <div style={{flexShrink:0,background:modal.color,padding:"15px 14px 13px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,borderRadius:9,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <Icon name={modal.icon} size={17} color="#fff" strokeWidth={1.9}/>
            </div>
            <div>
              <div style={{...sf(16,700,"#fff")}}>{modal.title}</div>
              <div style={{...sf(11,400,"rgba(255,255,255,0.75)"),marginTop:1}}>{modal.items.length} item{modal.items.length!==1?"s":""} · tap to expand</div>
            </div>
          </div>
          <div className="tap" onClick={onClose} style={{width:26,height:26,borderRadius:13,background:"rgba(255,255,255,0.22)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="dismiss" size={13} color="#fff" strokeWidth={2.4}/>
          </div>
        </div>

        {/* Scrollable accordion list */}
        <div
          onClick={e=>e.stopPropagation()}
          onTouchMove={e=>e.stopPropagation()}
          style={{flex:1,overflowY:"auto",overscrollBehavior:"contain",WebkitOverflowScrolling:"touch",padding:"10px 12px",display:"flex",flexDirection:"column",gap:8}}
        >
          {modal.items.length===0&&(
            <div style={{textAlign:"center",padding:"24px 0",...sf(13,400,T.label3)}}>No items to show</div>
          )}
          {modal.items.map((item,i)=>(
            <KpiItem key={i} item={item} kpiColor={modal.color} isOpen={openIdx===i} onToggle={()=>toggle(i)}/>
          ))}
        </div>

        <div style={{flexShrink:0,padding:"8px 0 12px",borderTop:`0.5px solid ${T.sep}`,textAlign:"center"}}>
          <div style={{...sf(11,400,T.label3)}}>Tap outside to close</div>
        </div>
      </div>
    </div>
  );
}

// ─── Client Contact Card — expandable with full profile + activity feed ───────
function ClientContactCard({ct,isOpen,onToggle,onRemove,gmail}){
  const initials=ct.name.split(" ").map(n=>n[0]).join("").slice(0,2);
  const [activityTab,setActivityTab]=useState("activity"); // "activity" | "addNote"
  const [newNote,setNewNote]=useState("");
  const [activities,setActivities]=useState(ct.activities||[]);

  const addNote=()=>{
    if(!newNote.trim())return;
    const entry={id:Date.now(),type:"note",text:newNote.trim(),date:"Mar 27, 2025",time:"Just now"};
    setActivities(p=>[entry,...p]);
    setNewNote("");setActivityTab("activity");
  };

  const activityIconMap={
    note:{name:"note",bg:"rgba(0,122,255,0.10)",color:T.blue},
    call:{name:"phone",bg:"rgba(52,199,89,0.10)",color:T.green},
    email:{name:"mail",bg:"rgba(175,82,222,0.10)",color:T.purple},
    meeting:{name:"people",bg:"rgba(255,149,0,0.10)",color:T.orange},
    intro:{name:"send",bg:"rgba(90,200,250,0.12)",color:T.teal},
  };

  return(
    <div style={{background:T.card,borderRadius:12,marginBottom:10,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,0.07)"}}>
      {/* Collapsed header row */}
      <div className="tap" onClick={onToggle}
        style={{display:"flex",alignItems:"center",gap:11,padding:"12px 13px"}}>
        <Avatar initials={initials} size={40}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{...sf(14,600,T.label)}}>{ct.name}</span>
            {ct.primary&&<span style={{...sf(10,600,T.blue),background:"rgba(0,122,255,0.10)",borderRadius:4,padding:"1px 6px",flexShrink:0}}>Primary</span>}
          </div>
          <div style={{...sf(12,400,T.label3),marginTop:2}}>{ct.title}</div>
        </div>
        <div style={{transform:isOpen?"rotate(90deg)":"rotate(0deg)",transition:`transform 0.2s ${T.ease}`,flexShrink:0,display:"flex",alignItems:"center"}}>
          <Icon name="chevronRight" size={14} color={T.gray3} strokeWidth={2}/>
        </div>
      </div>

      {/* Expanded panel */}
      {isOpen&&(
        <div style={{borderTop:`0.5px solid ${T.sep}`}}>
          <div style={{padding:"12px 13px 0"}}>

            {/* ── Contact info rows — phone tappable to dial ── */}
            {[
              {icon:"briefcase",value:ct.title,  color:T.label3, href:null},
              {icon:"mail",     value:ct.email,   color:T.blue,   href:null},
              {icon:"phone",    value:ct.phone,   color:T.green,  href:`tel:${ct.phone}`},
            ].filter(r=>r.value).map(r=>(
              r.href
                ? <a key={r.value} href={r.href} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 0",borderBottom:`0.5px solid ${T.sep}`,textDecoration:"none"}}>
                    <Icon name={r.icon} size={14} color={r.color} strokeWidth={1.7}/>
                    <span style={{...sf(13,400,r.color)}}>{r.value}</span>
                  </a>
                : <div key={r.value} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 0",borderBottom:`0.5px solid ${T.sep}`}}>
                    <Icon name={r.icon} size={14} color={r.color} strokeWidth={1.7}/>
                    <span style={{...sf(13,400,T.label2)}}>{r.value}</span>
                  </div>
            ))}

            {/* ── Quick actions ── */}
            <div style={{display:"flex",gap:7,marginTop:11,marginBottom:14,flexWrap:"wrap"}}>
              <a href={`tel:${ct.phone}`} style={{textDecoration:"none"}}>
                <GhostBtn label="Call" icon="phone" color={T.green} onPress={()=>{}}/>
              </a>
              <GhostBtn label="Email" icon="mail"  color={T.blue}  onPress={()=>gmail?.openCompose({email:ct.email,name:ct.name,subject:`Following up`,body:"Hi,\n\n"})}/>
              <button onClick={e=>{e.stopPropagation();onRemove(ct.id);}} className="tap"
                style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,border:"none",background:`${T.red}10`,borderRadius:8,padding:"6px 11px",color:T.red,...sf(12,600),cursor:"pointer"}}>
                <Icon name="trash" size={12} color={T.red} strokeWidth={2}/>Remove
              </button>
            </div>
          </div>

          {/* ── Activity section ── */}
          <div style={{borderTop:`0.5px solid ${T.sep}`,padding:"12px 13px 14px"}}>
            {/* Section header */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}>
                <Icon name="activity" size={14} color={T.label3} strokeWidth={1.8}/>
                <span style={{...sf(12,700,T.label3),textTransform:"uppercase",letterSpacing:"0.07em"}}>Activity</span>
                {activities.length>0&&<span style={{...sf(11,600,T.blue),background:"rgba(0,122,255,0.10)",borderRadius:10,padding:"1px 7px"}}>{activities.length}</span>}
              </div>
              {activityTab==="activity"&&(
                <div className="tap" onClick={()=>setActivityTab("addNote")}
                  style={{display:"flex",alignItems:"center",gap:5,...sf(12,500,T.blue),cursor:"pointer"}}>
                  <Icon name="plus" size={13} color={T.blue} strokeWidth={2.2}/>Note
                </div>
              )}
            </div>

            {/* Add note form */}
            {activityTab==="addNote"&&(
              <div style={{background:T.bg,borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                <div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>New Note</div>
                <textarea
                  value={newNote} onChange={e=>setNewNote(e.target.value)}
                  autoFocus placeholder="Log a call, email, meeting, or note…" rows={3}
                  style={{width:"100%",border:"none",outline:"none",...sf(13,400,T.label),background:"transparent",resize:"none",lineHeight:1.6}}
                />
                <div style={{display:"flex",gap:7,marginTop:8}}>
                  <GhostBtn label="Save" icon="check" color={T.blue} onPress={addNote}/>
                  <GhostBtn label="Cancel" color={T.gray} onPress={()=>{setNewNote("");setActivityTab("activity");}}/>
                </div>
              </div>
            )}

            {/* Activity feed */}
            {activities.length===0&&activityTab!=="addNote"&&(
              <div style={{textAlign:"center",padding:"14px 0"}}>
                <Icon name="activity" size={24} color={T.gray4} strokeWidth={1.4}/>
                <div style={{...sf(12,400,T.label3),marginTop:6}}>No activity yet</div>
                <div className="tap" onClick={()=>setActivityTab("addNote")}
                  style={{...sf(12,500,T.blue),marginTop:4,cursor:"pointer"}}>Log first note ›</div>
              </div>
            )}

            {activities.map((a,i)=>{
              const meta=activityIconMap[a.type]||activityIconMap.note;
              return(
                <div key={a.id} style={{display:"flex",gap:10,alignItems:"flex-start",padding:"8px 0",borderBottom:i<activities.length-1?`0.5px solid ${T.sep}`:"none"}}>
                  <div style={{width:28,height:28,borderRadius:8,background:meta.bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>
                    <Icon name={meta.name} size={14} color={meta.color} strokeWidth={1.8}/>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{...sf(13,400,T.label),lineHeight:1.5}}>{a.text}</div>
                    <div style={{...sf(11,400,T.label3),marginTop:3}}>{a.date} · {a.time}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Gmail Emails section ── */}
          {gmail?.gmailUser&&(
            <div style={{borderTop:`0.5px solid ${T.sep}`,padding:"12px 13px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                <div style={{width:16,height:16,borderRadius:4,background:"#EA4335",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <Icon name="mail" size={9} color="#fff" strokeWidth={2}/>
                </div>
                <span style={{...sf(12,700,T.label3),textTransform:"uppercase",letterSpacing:"0.07em"}}>Gmail Emails</span>
                {gmail.lastSync&&<span style={{...sf(10,400,T.label3)}}>Updated {gmail.lastSync.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
                <div className="tap" onClick={()=>gmail.openCompose({email:ct.email,name:ct.name,subject:"Following up",body:"Hi,\n\n"})}
                  style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:4,...sf(12,500,T.blue)}}>
                  <Icon name="plus" size={13} color={T.blue} strokeWidth={2.2}/>Compose
                </div>
              </div>
              <GmailThreadView emails={ct.gmailEmails} contactName={ct.name}/>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ClientContactsList({contacts,openContactId,onToggle,onRemove,gmail}){
  return(
    <div>
      {contacts.map(ct=>(
        <ClientContactCard key={ct.id} ct={ct} isOpen={openContactId===ct.id} onToggle={()=>onToggle(ct.id)} onRemove={onRemove} gmail={gmail}/>
      ))}
    </div>
  );
}

function ClientCard({client,setClients,jobs,last,gmail}){
  const [open,setOpen]=useState(false);const [tab,setTab]=useState("overview");
  const [editing,setEditing]=useState(false);const [draft,setDraft]=useState({...client});
  const [addingContact,setAddingContact]=useState(false);const [newContact,setNewContact]=useState({name:"",title:"",email:"",phone:""});
  const [addingNote,setAddingNote]=useState(false);const [newNote,setNewNote]=useState("");
  const [editingNote,setEditingNote]=useState(null);const [noteText,setNoteText]=useState("");
  const [openContactId,setOpenContactId]=useState(null);
  // Mini-modal for Fees / Open roles drill-down
  const [miniModal,setMiniModal]=useState(null); // null | { type:"fees"|"open", items:[], title, icon, color }

  const save=()=>{setClients(p=>p.map(c=>c.id===client.id?draft:c));setEditing(false);};
  const addContact=()=>{if(!newContact.name)return;const updated={...client,contacts:[...client.contacts,{...newContact,id:Date.now(),primary:false}]};setClients(p=>p.map(c=>c.id===client.id?updated:c));setDraft(updated);setNewContact({name:"",title:"",email:"",phone:""});setAddingContact(false);};
  const removeContact=(cid)=>{const updated={...client,contacts:client.contacts.filter(c=>c.id!==cid)};setClients(p=>p.map(c=>c.id===client.id?updated:c));setDraft(updated);};
  const addNote=()=>{if(!newNote.trim())return;const nn={id:Date.now(),text:newNote.trim(),date:"Mar 27, 2025"};const updated={...client,notes:[nn,...client.notes]};setClients(p=>p.map(c=>c.id===client.id?updated:c));setDraft(updated);setNewNote("");setAddingNote(false);};
  const saveNote=(nid)=>{const updated={...client,notes:client.notes.map(n=>n.id===nid?{...n,text:noteText}:n)};setClients(p=>p.map(c=>c.id===client.id?updated:c));setDraft(updated);setEditingNote(null);};
  const deleteNote=(nid)=>{const updated={...client,notes:client.notes.filter(n=>n.id!==nid)};setClients(p=>p.map(c=>c.id===client.id?updated:c));setDraft(updated);};

  const clientJobs=jobs.filter(j=>client.linkedJobs.includes(j.id));
  const openJobs=clientJobs.filter(j=>j.stage!=="Filled");
  const filledJobs=clientJobs.filter(j=>j.stage==="Filled");

  const openFeesModal=()=>{
    setMiniModal({
      title:"Total Fees",icon:"revenue",color:T.blue,
      items:clientJobs.map(j=>({
        title:j.title, sub:`${j.stage} · ${j.candidates} candidates`,
        value:j.fee, badge:j.stage,
        badgeColor:j.stage==="Active"?T.green:j.stage==="Filled"?T.gray:T.orange,
        icon:"briefcase", urgent:j.urgent,
        notes:j.notes,
        detail:[
          {icon:"building",value:j.company,color:T.label3},
          {icon:"calendar",value:`Due ${j.deadline}`,color:T.label3},
          {icon:"money",value:j.fee,color:T.blue},
        ],
      })),
    });
  };

  const openRolesModal=()=>{
    setMiniModal({
      title:"Open Roles",icon:"briefcase",color:T.orange,
      items:openJobs.map(j=>({
        title:j.title, sub:`${j.stage} · Due ${j.deadline}`,
        value:j.fee, badge:j.stage,
        badgeColor:j.stage==="Active"?T.green:T.orange,
        icon:"briefcase", urgent:j.urgent,
        notes:j.notes,
        detail:[
          {icon:"building",value:j.company,color:T.label3},
          {icon:"calendar",value:`Due ${j.deadline}`,color:T.label3},
          {icon:"people",value:`${j.candidates} candidates`,color:T.label3},
          {icon:"money",value:j.fee,color:T.blue},
        ],
      })),
    });
  };

  const TABS=[{id:"overview",label:"Overview",icon:"clients"},{id:"contacts",label:"Contacts",icon:"contact"},{id:"jobs",label:"Jobs",icon:"briefcase"},{id:"notes",label:"Notes",icon:"note"}];
  return(
    <div style={{borderBottom:last&&!open?"none":`0.5px solid ${T.sep}`,position:"relative"}}>
      <div className="tap" onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",background:T.card}}>
        <LogoBadge letters={client.logo} color={client.logoColor} size={44}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{...sf(15,600,T.label)}}>{client.name}</span><StatusPill status={client.status} small/></div>
          <div style={{...sf(13,400,T.label3),marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{client.industry} · {client.primaryContact.name}</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0,marginRight:6}}>
          <div style={{...sf(14,700,T.blue)}}>{client.totalFees==="$0"?"—":client.totalFees}</div>
          <div style={{...sf(11,400,T.label3),marginTop:2}}>{client.openRoles} open role{client.openRoles!==1?"s":""}</div>
        </div>
        <Chevron open={open}/>
      </div>
      {open&&(
        <div className="expand" style={{background:"#F8F8FA",borderTop:`0.5px solid ${T.sep}`}}>
          <SubTabStrip tabs={TABS} active={tab} onChange={setTab}/>
          {tab==="overview"&&<div style={{padding:"14px 16px 4px"}}>{editing?(
            <>
              {[{k:"name",l:"Company"},{k:"industry",l:"Industry"},{k:"website",l:"Website"},{k:"revenue",l:"Revenue"},{k:"employees",l:"Employees"},{k:"address",l:"Address"}].map(f=>(<div key={f.k} style={{marginBottom:11}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>{f.l}</div><input value={draft[f.k]||""} onChange={e=>setDraft(d=>({...d,[f.k]:e.target.value}))} style={{width:"100%",background:T.card,border:`0.5px solid ${T.gray4}`,borderRadius:9,padding:"9px 12px",...sf(15),outline:"none"}}/></div>))}
              <div style={{marginBottom:14}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>Status</div><div style={{display:"flex",gap:7}}>{["Active","Pending","Closed"].map(s=>(<div key={s} className="tap" onClick={()=>setDraft(d=>({...d,status:s}))} style={{borderRadius:20,padding:"6px 14px",...sf(13,draft.status===s?600:400,draft.status===s?"#fff":T.gray),background:draft.status===s?CLIENT_STATUS[s].color:T.gray5,transition:"all 0.18s"}}>{s}</div>))}</div></div>
            </>
          ):(
            <div style={{paddingBottom:8}}>
              {/* Stats strip — Fees and Open are tappable */}
              <div style={{display:"flex",background:T.card,borderRadius:10,overflow:"hidden",border:`0.5px solid ${T.sep}`,marginBottom:12}}>
                {/* Fees — tappable */}
                <div className="tap" onClick={e=>{e.stopPropagation();openFeesModal();}}
                  style={{flex:1,padding:"12px 8px",borderRight:`0.5px solid ${T.sep}`,textAlign:"center"}}>
                  <Icon name="revenue" size={15} color={T.blue} strokeWidth={1.6}/>
                  <div style={{...sf(13,700,T.blue),marginTop:3}}>{client.totalFees==="$0"?"—":client.totalFees}</div>
                  <div style={{...sf(10,400,T.label3),marginTop:1,textTransform:"uppercase",letterSpacing:"0.05em"}}>Fees</div>
                  <div style={{...sf(9,400,T.blue),marginTop:1}}>tap to view ›</div>
                </div>
                {/* Since — not tappable */}
                <div style={{flex:1,padding:"12px 8px",borderRight:`0.5px solid ${T.sep}`,textAlign:"center"}}>
                  <Icon name="calendar" size={15} color={T.purple} strokeWidth={1.6}/>
                  <div style={{...sf(13,700,T.purple),marginTop:3}}>{client.since}</div>
                  <div style={{...sf(10,400,T.label3),marginTop:1,textTransform:"uppercase",letterSpacing:"0.05em"}}>Since</div>
                </div>
                {/* Open Roles — tappable */}
                <div className="tap" onClick={e=>{e.stopPropagation();openRolesModal();}}
                  style={{flex:1,padding:"12px 8px",textAlign:"center"}}>
                  <Icon name="briefcase" size={15} color={T.orange} strokeWidth={1.6}/>
                  <div style={{...sf(13,700,T.orange),marginTop:3}}>{client.openRoles}</div>
                  <div style={{...sf(10,400,T.label3),marginTop:1,textTransform:"uppercase",letterSpacing:"0.05em"}}>Open</div>
                  <div style={{...sf(9,400,T.orange),marginTop:1}}>tap to view ›</div>
                </div>
              </div>
              {[{icon:"globe",label:"Website",value:client.website,color:T.blue},{icon:"industry",label:"Industry",value:client.industry,color:T.indigo},{icon:"revenue",label:"Revenue",value:client.revenue,color:T.green},{icon:"people",label:"Team",value:`${client.employees} people`,color:T.orange},{icon:"building",label:"Address",value:client.address,color:T.gray}].map(r=>(<div key={r.label} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:`0.5px solid ${T.sep}`}}><Icon name={r.icon} size={14} color={r.color} strokeWidth={1.6}/><div style={{minWidth:0}}><div style={{...sf(10,600,T.label3),textTransform:"uppercase",letterSpacing:"0.06em"}}>{r.label}</div><div style={{...sf(13,400,T.label2),marginTop:1}}>{r.value}</div></div></div>))}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>{(client.tags||[]).map(t=><Pill key={t} label={t} color={T.indigo}/>)}</div>
            </div>
          )}
          <div style={{display:"flex",gap:8,paddingBottom:14}}><GhostBtn label={editing?"Save Changes":"Edit"} icon={editing?"check":"edit"} color={T.blue} onPress={editing?save:()=>setEditing(true)}/>{editing&&<GhostBtn label="Cancel" color={T.gray} onPress={()=>{setDraft({...client});setEditing(false);}}/>}{!editing&&<GhostBtn label="Visit Site" icon="link" color={T.teal} onPress={()=>{}}/>}</div>
          </div>}
          {tab==="contacts"&&<div style={{padding:"14px 16px 4px"}}>
            <ClientContactsList
              contacts={client.contacts}
              openContactId={openContactId}
              onToggle={id=>setOpenContactId(p=>p===id?null:id)}
              onRemove={removeContact}
              gmail={gmail}
            />
            {addingContact?(<div style={{background:T.card,borderRadius:10,padding:"12px",border:`0.5px solid ${T.sep}`,marginBottom:10}}>
              <div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:10}}>New Contact</div>
              {[{k:"name",ph:"Full Name"},{k:"title",ph:"Title"},{k:"email",ph:"Email"},{k:"phone",ph:"Phone"}].map((f,i,a)=>(<div key={f.k} style={{borderBottom:i<a.length-1?`0.5px solid ${T.sep}`:"none"}}><input value={newContact[f.k]} onChange={e=>setNewContact(p=>({...p,[f.k]:e.target.value}))} placeholder={f.ph} style={{width:"100%",border:"none",outline:"none",...sf(14,400,T.label),background:"transparent",padding:"8px 0"}}/></div>))}
              <div style={{display:"flex",gap:7,marginTop:12}}><GhostBtn label="Add Contact" icon="check" color={T.blue} onPress={addContact}/><GhostBtn label="Cancel" color={T.gray} onPress={()=>setAddingContact(false)}/></div>
            </div>):(<div className="tap" onClick={()=>setAddingContact(true)} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0",marginBottom:10}}><div style={{width:32,height:32,borderRadius:16,background:"rgba(0,122,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="plus" size={16} color={T.blue} strokeWidth={2.2}/></div><span style={{...sf(14,500,T.blue)}}>Add Contact</span></div>)}
          </div>}
          {tab==="jobs"&&<div style={{padding:"14px 16px 4px"}}>
            {clientJobs.length===0&&<div style={{textAlign:"center",padding:"20px 0"}}><IconBadge name="briefcase" bg="rgba(0,122,255,0.08)" iconColor={T.blue} size={48}/><div style={{...sf(14,500,T.label3),marginTop:10}}>No linked jobs</div></div>}
            {clientJobs.map(job=>(<div key={job.id} style={{background:T.card,borderRadius:10,padding:"12px 14px",marginBottom:10,border:`0.5px solid ${T.sep}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:7}}><span style={{...sf(14,600,T.label)}}>{job.title}</span>{job.urgent&&<Icon name="alert" size={14} color={T.red} strokeWidth={1.8}/>}</div><div style={{...sf(12,400,T.label3),marginTop:2}}>Due {job.deadline} · {job.candidates} candidates</div></div>
                <div style={{textAlign:"right"}}><div style={{...sf(14,700,T.blue)}}>{job.fee}</div><div style={{marginTop:4}}><Pill label={job.stage} color={job.stage==="Active"?T.green:job.stage==="Filled"?T.gray:T.orange}/></div></div>
              </div>
              {job.notes&&<div style={{...sf(12,400,T.label3),marginTop:8,lineHeight:1.5}}>{job.notes}</div>}
            </div>))}
          </div>}
          {tab==="notes"&&<div style={{padding:"14px 16px 4px"}}>
            {addingNote?(<div style={{background:T.card,borderRadius:10,padding:"12px",border:`0.5px solid ${T.sep}`,marginBottom:12}}>
              <div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>New Note</div>
              <textarea value={newNote} onChange={e=>setNewNote(e.target.value)} autoFocus placeholder="Add a note…" rows={3} style={{width:"100%",border:"none",outline:"none",...sf(14,400,T.label),background:"transparent",resize:"none",lineHeight:1.6}}/>
              <div style={{display:"flex",gap:7,marginTop:10}}><GhostBtn label="Save Note" icon="check" color={T.blue} onPress={addNote}/><GhostBtn label="Cancel" color={T.gray} onPress={()=>setAddingNote(false)}/></div>
            </div>):(<div className="tap" onClick={()=>setAddingNote(true)} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0",marginBottom:10}}><div style={{width:32,height:32,borderRadius:16,background:"rgba(0,122,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="plus" size={16} color={T.blue} strokeWidth={2.2}/></div><span style={{...sf(14,500,T.blue)}}>Add Note</span></div>)}
            {client.notes.map(n=>(<div key={n.id} style={{background:T.card,borderRadius:10,padding:"12px",marginBottom:10,border:`0.5px solid ${T.sep}`}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><div style={{display:"flex",alignItems:"center",gap:7}}><Icon name="note" size={13} color={T.label3} strokeWidth={1.7}/><span style={{...sf(11,400,T.label3)}}>{n.date}</span></div><div style={{display:"flex",gap:10}}><div className="tap" onClick={()=>{setEditingNote(n.id);setNoteText(n.text);}}><Icon name="edit" size={14} color={T.blue} strokeWidth={1.8}/></div><div className="tap" onClick={()=>deleteNote(n.id)}><Icon name="trash" size={14} color={T.gray3} strokeWidth={1.8}/></div></div></div>
              {editingNote===n.id?(<><textarea value={noteText} onChange={e=>setNoteText(e.target.value)} autoFocus rows={3} style={{width:"100%",border:"none",outline:"none",...sf(13,400,T.label),background:"transparent",resize:"none",lineHeight:1.6}}/><div style={{display:"flex",gap:7,marginTop:8}}><GhostBtn label="Save" icon="check" color={T.blue} onPress={()=>saveNote(n.id)}/><GhostBtn label="Cancel" color={T.gray} onPress={()=>setEditingNote(null)}/></div></>)
              :<div style={{...sf(13,400,T.label2),lineHeight:1.65}}>{n.text}</div>}
            </div>))}
          </div>}
        </div>
      )}

      {/* Client mini-modal — KPI-style, rendered as sibling at ClientCard level */}
      {miniModal&&(
        <ClientMiniModal
          modal={miniModal}
          onClose={()=>setMiniModal(null)}
        />
      )}
    </div>
  );
}

// ─── Tab Bar (5 tabs) ─────────────────────────────────────────────────────────
function TabBar({active,onChange}){
  const tabs=[
    {id:"dashboard",icon:"house",    label:"Home"},
    {id:"pipeline", icon:"chart",    label:"Pipeline"},
    {id:"clients",  icon:"clients",  label:"Clients"},
    {id:"contacts", icon:"people",   label:"People"},
    {id:"jobs",     icon:"briefcase",label:"Jobs"},
  ];
  return(
    <div style={{flexShrink:0,zIndex:200,background:"rgba(249,249,249,0.94)",backdropFilter:"blur(20px) saturate(180%)",WebkitBackdropFilter:"blur(20px) saturate(180%)",borderTop:`0.5px solid ${T.sep}`,display:"flex",padding:`8px 0 calc(env(safe-area-inset-bottom, 20px) + 4px)`}}>
      {tabs.map(t=>{const on=active===t.id;return(
        <div key={t.id} className="tap" onClick={()=>onChange(t.id)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
          <Icon name={t.icon} size={22} color={on?T.blue:T.gray3} strokeWidth={on?2:1.6}/>
          <span style={{...sf(9,on?700:400,on?T.blue:T.gray),transition:"color 0.18s",letterSpacing:"0.01em"}}>{t.label}</span>
        </div>
      );})}
    </div>
  );
}

// ─── Real-time greeting hook ──────────────────────────────────────────────────
function useGreeting() {
  const getState = () => {
    const now = new Date();
    const h = now.getHours();
    const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const dateStr = `${days[now.getDay()]} · ${months[now.getMonth()]} ${now.getDate()}`;
    return { greeting, dateStr };
  };
  const [state, setState] = useState(getState);
  useEffect(() => {
    // Update at the top of every minute
    const tick = () => setState(getState());
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const timeout = setTimeout(() => {
      tick();
      const interval = setInterval(tick, 60000);
      return () => clearInterval(interval);
    }, msUntilNextMinute);
    return () => clearTimeout(timeout);
  }, []);
  return state;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({contacts,setContacts,jobs,setJobs,clients,activities,setActivities,onNavigate,nbaActions,onDismissNBA,onOpenKpi,onOpenNBA,gmail}){
  const { greeting, dateStr } = useGreeting();
  const pipeVal=jobs.filter(j=>j.stage!=="Filled").reduce((s,j)=>s+parseInt(j.fee.replace(/\D/g,"")),0);
  const criticalCount=nbaActions.filter(a=>a.priority==="critical").length;

  const kpis=[
    {key:"pipeline",label:"Pipeline", value:`$${(pipeVal/1000).toFixed(0)}k`,sub:"open fees",     color:T.blue,   icon:"money"},
    {key:"clients", label:"Clients",  value:clients.filter(c=>c.status==="Active").length,sub:"active",color:T.indigo,icon:"clients"},
    {key:"hot",     label:"Hot Leads",value:contacts.filter(c=>c.hot).length,sub:"follow up",   color:T.red,    icon:"fire"},
    {key:"placed",  label:"Placed",   value:contacts.filter(c=>c.stage==="Placed").length,sub:"this month",color:T.green,icon:"checkCircle"},
  ];

  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{padding:"calc(env(safe-area-inset-top, 44px) + 16px) 20px 20px",background:T.card}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:2}}>
          <div>
            <div style={{...sf(12,500,T.label3),textTransform:"uppercase",letterSpacing:"0.09em",marginBottom:4}}>{dateStr}</div>
            <div style={{...sf(28,700,T.label)}}>{greeting}</div>
          </div>
          {/* NBA Button */}
          <div className="tap" onClick={()=>onOpenNBA()} style={{position:"relative",marginTop:6}}>
            <div style={{width:42,height:42,borderRadius:13,background:"linear-gradient(135deg,#007AFF 0%,#AF52DE 100%)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 12px rgba(0,122,255,0.35)"}}>
              <Icon name="sparkle" size={20} color="#fff" strokeWidth={2}/>
            </div>
            {criticalCount>0&&<div style={{position:"absolute",top:-4,right:-4,width:18,height:18,borderRadius:9,background:T.red,border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",...sf(10,800,"#fff")}}>{criticalCount}</div>}
          </div>
        </div>

        {/* KPI Grid — tappable */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11,marginTop:16}}>
          {kpis.map((k,i)=>(
            <div key={k.key} className="pop-in tap" onClick={()=>onOpenKpi(k)} style={{animationDelay:`${i*0.05}s`,background:T.card,borderRadius:T.rLg,padding:"16px",boxShadow:`0 1px 0 rgba(0,0,0,0.04), 0 2px 18px rgba(0,0,0,0.06), 0 0 0 0.5px ${T.sep}`,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",right:-8,bottom:-8,opacity:0.06}}><Icon name={k.icon} size={64} color={k.color} strokeWidth={1.2}/></div>
              <Icon name={k.icon} size={22} color={k.color} strokeWidth={1.6}/>
              <div style={{...sf(30,700,k.color),letterSpacing:"-0.03em",lineHeight:1,marginTop:8}}>{k.value}</div>
              <div style={{...sf(12,600,T.label3),textTransform:"uppercase",letterSpacing:"0.05em",marginTop:5}}>{k.label}</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:2}}>
                <div style={{...sf(11,400,T.label3)}}>{k.sub}</div>
                <Icon name="chevronRight" size={12} color={T.gray4} strokeWidth={2}/>
              </div>
            </div>
          ))}
        </div>

        {/* Gmail status / connect prompt */}
        <GmailStatusBar
          gmailUser={gmail.gmailUser}
          syncing={gmail.syncing}
          lastSync={gmail.lastSync}
          onConnect={gmail.connectGmail}
          onDisconnect={gmail.disconnectGmail}
          onSync={gmail.syncEmails}
        />

        {/* NBA Inline Banner */}
        {nbaActions.length>0&&(
          <div className="tap" onClick={()=>onOpenNBA()} style={{marginTop:14,background:`linear-gradient(135deg, rgba(0,122,255,0.07) 0%, rgba(175,82,222,0.07) 100%)`,borderRadius:T.r,padding:"12px 14px",border:`0.5px solid rgba(0,122,255,0.2)`,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#007AFF,#AF52DE)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <Icon name="zap" size={18} color="#fff" strokeWidth={2}/>
            </div>
            <div style={{flex:1}}>
              <div style={{...sf(13,600,T.label)}}>{criticalCount>0?`${criticalCount} critical action${criticalCount!==1?"s":""} needed`:`${nbaActions.length} recommended actions`}</div>
              <div style={{...sf(11,400,T.label3),marginTop:2}}>{nbaActions[0].title}</div>
            </div>
            <Icon name="chevronRight" size={14} color={T.blue} strokeWidth={2}/>
          </div>
        )}
      </div>

      <div style={{height:1,background:T.sep}}/>
      <div style={{background:T.card}}>
        <SectionHead title="Urgent Roles" sub={`${jobs.filter(j=>j.urgent).length} need attention`} cta="See All" onCta={()=>onNavigate("jobs")}/>
        <ListCard style={{margin:"0 16px 16px"}}>{jobs.filter(j=>j.urgent).map((j,i,a)=><ExpandableJobCard key={j.id} job={j} setJobs={setJobs} last={i===a.length-1}/>)}</ListCard>
      </div>

      <div style={{height:1,background:T.sep}}/>
      <div style={{background:T.card}}>
        <SectionHead title="Active Clients" sub="Key accounts" cta="See All" onCta={()=>onNavigate("clients")}/>
        <ListCard style={{margin:"0 16px 16px"}}>
          {clients.filter(c=>c.status==="Active").slice(0,3).map((c,i,a)=>(
            <div key={c.id} className="tap" onClick={()=>onNavigate("clients")} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",borderBottom:i<a.length-1?`0.5px solid ${T.sep}`:"none",background:T.card}}>
              <LogoBadge letters={c.logo} color={c.logoColor} size={38}/>
              <div style={{flex:1}}><div style={{...sf(14,600,T.label)}}>{c.name}</div><div style={{...sf(12,400,T.label3),marginTop:1}}>{c.industry} · {c.openRoles} open role{c.openRoles!==1?"s":""}</div></div>
              <div style={{textAlign:"right"}}><div style={{...sf(13,700,T.blue)}}>{c.totalFees==="$0"?"—":c.totalFees}</div><StatusPill status={c.status} small/></div>
              <Icon name="chevronRight" size={14} color={T.gray4} strokeWidth={2}/>
            </div>
          ))}
        </ListCard>
      </div>

      <div style={{height:1,background:T.sep}}/>
      <div style={{background:T.card}}>
        <SectionHead title="Hot Candidates" sub="Flagged for follow-up" cta="See All" onCta={()=>onNavigate("contacts")}/>
        <ListCard style={{margin:"0 16px 16px"}}>{contacts.filter(c=>c.hot).map((c,i,a)=><ExpandableContactCard key={c.id} contact={c} setContacts={setContacts} last={i===a.length-1}/>)}</ListCard>
      </div>

      <div style={{height:1,background:T.sep}}/>
      <div style={{background:T.card}}>
        <SectionHead title="Recent Activity" sub="Tap to expand"/>
        <ListCard style={{margin:"0 16px 16px"}}>{activities.map((a,i)=><ExpandableActivityCard key={a.id} act={a} setActivities={setActivities} last={i===activities.length-1}/>)}</ListCard>
      </div>

      {/* KPI Floating Modal */}
      {/* (now rendered at App root) */}
      {/* NBA Floating Modal */}
      {/* (now rendered at App root) */}
    </div>
  );
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────
function Pipeline({contacts,setContacts,gmail}){
  const [filter,setFilter]=useState("All");
  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{padding:"calc(env(safe-area-inset-top, 44px) + 16px) 16px 12px",background:T.card,borderBottom:`0.5px solid ${T.sep}`,position:"sticky",top:0,zIndex:10}}>
        <div style={{...sf(28,700,T.label),marginBottom:12}}>Pipeline</div>
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:2}}>
          {["All",...STAGES].map(s=>{const on=filter===s;const m=STAGE_META[s];return(<div key={s} className="tap" onClick={()=>setFilter(s)} style={{borderRadius:20,padding:"6px 14px",flexShrink:0,background:on?(m?m.color:T.blue):T.gray5,color:on?"#fff":T.gray,...sf(13,on?600:400,on?"#fff":T.gray),transition:`all 0.18s ${T.ease}`}}>{s}</div>);})}
        </div>
      </div>
      {STAGES.filter(s=>filter==="All"||filter===s).map(stage=>{
        const group=contacts.filter(c=>c.stage===stage);
        if(!group.length)return null;
        return(<div key={stage}><div style={{height:1,background:T.sep}}/><div style={{background:T.card}}><SectionHead title={stage} sub={`${group.length} candidate${group.length!==1?"s":""}`}/><ListCard style={{margin:"0 16px 16px"}}>{group.map((c,i)=><ExpandableContactCard key={c.id} contact={c} setContacts={setContacts} last={i===group.length-1} gmail={gmail}/>)}</ListCard></div></div>);
      })}
    </div>
  );
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
function Contacts({contacts,setContacts,gmail}){
  const [search,setSearch]=useState("");const [showAdd,setShowAdd]=useState(false);
  if(showAdd) return <AddContactForm onBack={()=>setShowAdd(false)} onSave={c=>{setContacts(p=>[...p,{...c,id:Date.now(),avatar:c.name.split(" ").map(n=>n[0]).join("").slice(0,2),lastContact:"Just now",lastContactDays:0,hot:false,resume:null}]);setShowAdd(false);}}/>;
  const filtered=contacts.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())||c.company.toLowerCase().includes(search.toLowerCase())||c.title.toLowerCase().includes(search.toLowerCase()));
  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{padding:"calc(env(safe-area-inset-top, 44px) + 16px) 16px 12px",background:T.card,borderBottom:`0.5px solid ${T.sep}`,position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div style={{...sf(28,700,T.label)}}>Candidates</div><div className="tap" onClick={()=>setShowAdd(true)} style={{background:T.blue,borderRadius:20,padding:"7px 14px",display:"flex",alignItems:"center",gap:6,...sf(14,600,"#fff"),cursor:"pointer"}}><Icon name="plus" size={14} color="#fff" strokeWidth={2.5}/>New</div></div>
        <div style={{background:T.gray5,borderRadius:11,padding:"9px 14px",display:"flex",gap:8,alignItems:"center"}}><Icon name="people" size={16} color={T.gray} strokeWidth={1.6}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search candidates…" style={{background:"none",border:"none",outline:"none",...sf(16,400,T.label),flex:1}}/></div>
      </div>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"16px 16px 0"}}>{filtered.map((c,i)=><ExpandableContactCard key={c.id} contact={c} setContacts={setContacts} last={i===filtered.length-1} gmail={gmail}/>)}{!filtered.length&&<div style={{padding:"36px 0",textAlign:"center",...sf(15,400,T.label3)}}>No candidates found</div>}</ListCard>
    </div>
  );
}

function AddContactForm({onBack,onSave}){
  const [f,setF]=useState({name:"",title:"",company:"",email:"",phone:"",salary:"",tags:"",stage:"Sourced"});
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const fields=[{k:"name",l:"Full Name",ph:"Jane Smith"},{k:"title",l:"Title",ph:"Sr. Engineer"},{k:"company",l:"Company",ph:"Google"},{k:"email",l:"Email",ph:"jane@co.com"},{k:"phone",l:"Phone",ph:"+1 415 555 0000"},{k:"salary",l:"Salary",ph:"$180k"},{k:"tags",l:"Skills",ph:"React, Node, AWS"}];
  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 16px 16px",background:T.card,borderBottom:`0.5px solid ${T.sep}`}}><span className="tap" onClick={onBack} style={{...sf(16,400,T.blue),cursor:"pointer"}}>Cancel</span><span style={{...sf(16,600,T.label)}}>New Candidate</span><span className="tap" onClick={()=>f.name&&onSave({...f,tags:f.tags.split(",").map(t=>t.trim()).filter(Boolean)})} style={{...sf(16,600,T.blue),cursor:"pointer"}}>Add</span></div>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px"}}>{fields.map((fi,i)=>(<div key={fi.k} style={{borderBottom:i<fields.length-1?`0.5px solid ${T.sep}`:"none"}}><div style={{display:"flex",alignItems:"center",padding:"11px 16px",gap:12}}><div style={{width:72,flexShrink:0,...sf(13,400,T.label3)}}>{fi.l}</div><input value={f[fi.k]} onChange={e=>u(fi.k,e.target.value)} placeholder={fi.ph} style={{flex:1,border:"none",outline:"none",...sf(15,400,T.label),background:"transparent"}}/></div></div>))}</ListCard>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px",padding:"12px 16px"}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>Pipeline Stage</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{STAGES.map(s=>(<div key={s} className="tap" onClick={()=>u("stage",s)} style={{borderRadius:20,padding:"6px 12px",...sf(12,f.stage===s?600:400,f.stage===s?"#fff":T.gray),background:f.stage===s?STAGE_META[s].color:T.gray5,transition:"all 0.18s"}}>{s}</div>))}</div></ListCard>
    </div>
  );
}

// ─── Clients ──────────────────────────────────────────────────────────────────
function Clients({clients,setClients,jobs,gmail}){
  const [search,setSearch]=useState("");const [filterStatus,setFilterStatus]=useState("All");const [showAdd,setShowAdd]=useState(false);
  if(showAdd) return <AddClientForm onBack={()=>setShowAdd(false)} onSave={c=>{setClients(p=>[...p,{...c,id:Date.now(),totalFees:"$0",openRoles:0,contacts:[],linkedJobs:[],notes:[],logo:c.name.slice(0,2).toUpperCase(),logoColor:T.blue,lastOutreach:"Never",lastOutreachDays:999}]);setShowAdd(false);}}/>;
  const filtered=clients.filter(c=>{const ms=c.name.toLowerCase().includes(search.toLowerCase())||c.industry.toLowerCase().includes(search.toLowerCase());const mst=filterStatus==="All"||c.status===filterStatus;return ms&&mst;});
  const totalFees=clients.reduce((s,c)=>s+parseInt((c.totalFees||"$0").replace(/\D/g,"")),0);
  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{padding:"calc(env(safe-area-inset-top, 44px) + 16px) 16px 12px",background:T.card,borderBottom:`0.5px solid ${T.sep}`,position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div style={{...sf(28,700,T.label)}}>Clients</div><div className="tap" onClick={()=>setShowAdd(true)} style={{background:T.blue,borderRadius:20,padding:"7px 14px",display:"flex",alignItems:"center",gap:6,...sf(14,600,"#fff"),cursor:"pointer"}}><Icon name="plus" size={14} color="#fff" strokeWidth={2.5}/>New</div></div>
        <div style={{display:"flex",gap:20,marginBottom:12}}>{[{v:`$${(totalFees/1000).toFixed(0)}k`,l:"Total Fees",c:T.green},{v:clients.filter(c=>c.status==="Active").length,l:"Active",c:T.blue},{v:clients.length,l:"Total",c:T.gray}].map(s=>(<div key={s.l}><div style={{...sf(20,700,s.c)}}>{s.v}</div><div style={{...sf(10,400,T.label3),marginTop:1}}>{s.l}</div></div>))}</div>
        <div style={{background:T.gray5,borderRadius:11,padding:"9px 14px",display:"flex",gap:8,alignItems:"center",marginBottom:10}}><Icon name="building" size={16} color={T.gray} strokeWidth={1.6}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search clients…" style={{background:"none",border:"none",outline:"none",...sf(16,400,T.label),flex:1}}/></div>
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:2}}>{["All","Active","Pending","Closed"].map(s=>{const on=filterStatus===s;const m=CLIENT_STATUS[s];return(<div key={s} className="tap" onClick={()=>setFilterStatus(s)} style={{borderRadius:20,padding:"6px 14px",flexShrink:0,background:on?(m?m.color:T.blue):T.gray5,color:on?"#fff":T.gray,...sf(13,on?600:400,on?"#fff":T.gray),transition:`all 0.18s ${T.ease}`}}>{s}</div>);})}</div>
      </div>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"16px 16px 0"}}>{filtered.map((c,i)=><ClientCard key={c.id} client={c} setClients={setClients} jobs={jobs} last={i===filtered.length-1} gmail={gmail}/>)}{!filtered.length&&<div style={{padding:"36px 0",textAlign:"center",...sf(15,400,T.label3)}}>No clients found</div>}</ListCard>
    </div>
  );
}

function AddClientForm({onBack,onSave}){
  const [f,setF]=useState({name:"",industry:"",website:"",revenue:"",employees:"",address:"",since:"",status:"Active",tags:""});
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const fields=[{k:"name",l:"Company Name",ph:"Acme Corp"},{k:"industry",l:"Industry",ph:"Financial Technology"},{k:"website",l:"Website",ph:"acme.com"},{k:"revenue",l:"ARR / Revenue",ph:"$50M ARR"},{k:"employees",l:"Employees",ph:"200"},{k:"address",l:"Address",ph:"123 Market St, SF"}];
  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 16px 16px",background:T.card,borderBottom:`0.5px solid ${T.sep}`}}><span className="tap" onClick={onBack} style={{...sf(16,400,T.blue),cursor:"pointer"}}>Cancel</span><span style={{...sf(16,600,T.label)}}>New Client</span><span className="tap" onClick={()=>f.name&&onSave({...f,tags:f.tags.split(",").map(t=>t.trim()).filter(Boolean)})} style={{...sf(16,600,T.blue),cursor:"pointer"}}>Add</span></div>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px"}}>{fields.map((fi,i)=>(<div key={fi.k} style={{borderBottom:i<fields.length-1?`0.5px solid ${T.sep}`:"none"}}><div style={{display:"flex",alignItems:"center",padding:"11px 16px",gap:12}}><div style={{width:80,flexShrink:0,...sf(13,400,T.label3)}}>{fi.l}</div><input value={f[fi.k]} onChange={e=>u(fi.k,e.target.value)} placeholder={fi.ph} style={{flex:1,border:"none",outline:"none",...sf(15,400,T.label),background:"transparent"}}/></div></div>))}</ListCard>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px",padding:"12px 16px"}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>Status</div><div style={{display:"flex",gap:7}}>{["Active","Pending"].map(s=>(<div key={s} className="tap" onClick={()=>u("status",s)} style={{borderRadius:20,padding:"6px 14px",...sf(13,f.status===s?600:400,f.status===s?"#fff":T.gray),background:f.status===s?CLIENT_STATUS[s].color:T.gray5,transition:"all 0.18s"}}>{s}</div>))}</div></ListCard>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px",padding:"12px 16px"}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>Tags (comma-separated)</div><input value={f.tags} onChange={e=>u("tags",e.target.value)} placeholder="Retainer, FinTech, Series B" style={{width:"100%",border:"none",outline:"none",...sf(15,400,T.label),background:"transparent"}}/></ListCard>
    </div>
  );
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────
function Jobs({jobs,setJobs}){
  const [showAdd,setShowAdd]=useState(false);
  const totalFees=jobs.filter(j=>j.stage!=="Filled").reduce((s,j)=>s+parseInt(j.fee.replace(/\D/g,"")),0);
  const active=jobs.filter(j=>j.stage==="Active"),pending=jobs.filter(j=>j.stage==="Pending"),filled=jobs.filter(j=>j.stage==="Filled");
  if(showAdd) return <AddJobForm onBack={()=>setShowAdd(false)} onSave={j=>{setJobs(p=>[...p,{...j,id:Date.now(),candidates:0,urgent:false,deadlineDays:30}]);setShowAdd(false);}}/>;
  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{padding:"calc(env(safe-area-inset-top, 44px) + 16px) 16px 16px",background:T.card,borderBottom:`0.5px solid ${T.sep}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{...sf(28,700,T.label)}}>Jobs</div><div className="tap" onClick={()=>setShowAdd(true)} style={{background:T.blue,borderRadius:20,padding:"7px 14px",display:"flex",alignItems:"center",gap:6,...sf(14,600,"#fff"),cursor:"pointer"}}><Icon name="plus" size={14} color="#fff" strokeWidth={2.5}/>New Job</div></div>
        <div style={{display:"flex",gap:20,marginTop:12}}>{[{v:`$${(totalFees/1000).toFixed(0)}k`,l:"Pipeline",c:T.green},{v:active.length,l:"Active",c:T.blue},{v:filled.length,l:"Filled",c:T.gray}].map(s=>(<div key={s.l}><div style={{...sf(22,700,s.c)}}>{s.v}</div><div style={{...sf(11,400,T.label3)}}>{s.l}</div></div>))}</div>
      </div>
      {[[active,"Active"],[pending,"Pending"],[filled,"Filled"]].map(([arr,label])=>arr.length===0?null:(<div key={label}><div style={{height:1,background:T.sep}}/><div style={{background:T.card}}><SectionHead title={label} sub={`${arr.length} role${arr.length!==1?"s":""}`}/><ListCard style={{margin:"0 16px 16px"}}>{arr.map((j,i)=><ExpandableJobCard key={j.id} job={j} setJobs={setJobs} last={i===arr.length-1}/>)}</ListCard></div></div>))}
    </div>
  );
}

function AddJobForm({onBack,onSave}){
  const [f,setF]=useState({title:"",company:"",fee:"",deadline:"",stage:"Active",notes:"",description:""});
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const fields=[{k:"title",l:"Job Title",ph:"VP of Engineering"},{k:"company",l:"Company",ph:"Acme Corp"},{k:"fee",l:"Fee",ph:"$45,000"},{k:"deadline",l:"Deadline",ph:"Apr 30"}];
  return(
    <div style={{overflowY:"auto",paddingBottom:"calc(env(safe-area-inset-bottom, 20px) + 90px)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 16px 16px",background:T.card,borderBottom:`0.5px solid ${T.sep}`}}><span className="tap" onClick={onBack} style={{...sf(16,400,T.blue),cursor:"pointer"}}>Cancel</span><span style={{...sf(16,600,T.label)}}>New Job</span><span className="tap" onClick={()=>f.title&&onSave(f)} style={{...sf(16,600,T.blue),cursor:"pointer"}}>Add</span></div>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px"}}>{fields.map((fi,i)=>(<div key={fi.k} style={{borderBottom:i<fields.length-1?`0.5px solid ${T.sep}`:"none"}}><div style={{display:"flex",alignItems:"center",padding:"11px 16px",gap:12}}><div style={{width:72,flexShrink:0,...sf(13,400,T.label3)}}>{fi.l}</div><input value={f[fi.k]} onChange={e=>u(fi.k,e.target.value)} placeholder={fi.ph} style={{flex:1,border:"none",outline:"none",...sf(15,400,T.label),background:"transparent"}}/></div></div>))}</ListCard>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px",padding:"12px 16px"}}><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>Status</div><div style={{display:"flex",gap:8}}>{["Active","Pending"].map(s=>(<div key={s} className="tap" onClick={()=>u("stage",s)} style={{borderRadius:20,padding:"7px 16px",...sf(13,f.stage===s?600:400,f.stage===s?"#fff":T.gray),background:f.stage===s?T.blue:T.gray5,transition:"all 0.18s"}}>{s}</div>))}</div></ListCard>
      <div style={{height:1,background:T.sep}}/>
      <ListCard style={{margin:"0 16px",padding:"12px 16px"}}><div style={{display:"flex",alignItems:"center",gap:7,marginBottom:7}}><Icon name="description" size={15} color={T.label3} strokeWidth={1.7}/><div style={{...sf(11,600,T.label3),textTransform:"uppercase",letterSpacing:"0.07em"}}>Job Description</div></div><textarea value={f.description} onChange={e=>u("description",e.target.value)} placeholder={"About the Role\n\nResponsibilities\n• \n\nRequirements\n• \n\nCompensation\n"} rows={10} style={{width:"100%",border:"none",outline:"none",...sf(14,400,T.label),background:"transparent",resize:"vertical",lineHeight:1.7,minHeight:140}}/></ListCard>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App(){
  const [tab,setTab]=useState("dashboard");

  // All data backed by Supabase
  const [contacts,setContacts,contactsSynced] = useSupabaseTable("contacts", seedContacts);
  const [jobs,    setJobs,    jobsSynced]      = useSupabaseTable("jobs",     seedJobs);
  const [clients, setClients, clientsSynced]   = useSupabaseTable("clients",  seedClients);
  const [activities, setActivities, actSynced] = useSupabaseTable("activities", seedActivities);

  const [dismissedNBA,setDismissedNBA]=useState([]);
  const [kpiModal,setKpiModal]=useState(null);
  const [showNBA,setShowNBA]=useState(false);

  const isLoading = !contactsSynced || !jobsSynced || !clientsSynced || !actSynced;

  // Gmail — initialized after data loads so contacts/clients are available
  const gmail = useGmail(contacts||[], clients||[], setContacts, setClients);

  const allNBA=useIntelligence(contacts||[],jobs||[],clients||[]);
  const nbaActions=allNBA.filter(a=>!dismissedNBA.includes(a.id));
  const dismissNBA=(id)=>setDismissedNBA(p=>[...p,id]);
  const anyModalOpen=kpiModal!==null||showNBA||gmail.composeOpen;

  return(
    <>
      <GS/>
      {/* Full-screen — no fake phone frame */}
      <div style={{position:"fixed",inset:0,background:T.bg,display:"flex",flexDirection:"column",overflow:"hidden"}}>

        {/* Loading overlay */}
        {isLoading && <LoadingScreen/>}

        {/* Screen */}
        {!isLoading && (
          <div style={{flex:1,overflowY:anyModalOpen?"hidden":"auto",overflowX:"hidden",background:T.bg,position:"relative"}}>
            <div className="fade-in" key={tab}>
              {tab==="dashboard"&&<Dashboard
                contacts={contacts} setContacts={setContacts}
                jobs={jobs} setJobs={setJobs}
                clients={clients}
                activities={activities} setActivities={setActivities}
                onNavigate={setTab}
                nbaActions={nbaActions} onDismissNBA={dismissNBA}
                onOpenKpi={setKpiModal} onOpenNBA={()=>setShowNBA(true)}
                gmail={gmail}
              />}
              {tab==="pipeline" &&<Pipeline  contacts={contacts} setContacts={setContacts} gmail={gmail}/>}
              {tab==="clients"  &&<Clients   clients={clients} setClients={setClients} jobs={jobs} gmail={gmail}/>}
              {tab==="contacts" &&<Contacts  contacts={contacts} setContacts={setContacts} gmail={gmail}/>}
              {tab==="jobs"     &&<Jobs      jobs={jobs} setJobs={setJobs}/>}
            </div>

            {/* Modals — position fixed so they cover full screen on real device */}
            {kpiModal&&<KpiModal kpi={kpiModal} contacts={contacts||[]} jobs={jobs||[]} clients={clients||[]} onClose={()=>setKpiModal(null)}/>}
            {showNBA&&<NBAModal actions={nbaActions} onClose={()=>setShowNBA(false)} onDismiss={dismissNBA}/>}
          </div>
        )}

        {/* Gmail Compose Modal */}
        {gmail.composeOpen&&(
          <GmailComposeModal
            composeTo={gmail.composeTo}
            setComposeTo={gmail.setComposeTo}
            onSend={gmail.sendEmail}
            onClose={()=>gmail.setComposeOpen(false)}
          />
        )}

        {/* Tab bar — always at the bottom */}
        {!isLoading&&<TabBar active={tab} onChange={setTab}/>}
      </div>
    </>
  );
}
