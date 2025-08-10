import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabaseClient';

type Group = 'big' | 'middle' | 'today';
type Task = { id: string; title: string; done: boolean; group: Group; createdAt: number; updatedAt: number; };

const LS_KEY = 'tri_group_tasks_v1';
const LS_HISTORY_KEY = 'tri_group_tasks_history_v1';
const LS_SYNC_KEY = 'tri_sync_key';
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const groupLabel: Record<Group,string> = { big:'Big', middle:'Middle', today:'Today' };
const emptyState: Task[] = [
  { id: uid(), title: 'Tap to edit a task', done:false, group:'today', createdAt:Date.now(), updatedAt:Date.now() },
  { id: uid(), title: 'Drag me to Middle or Big', done:false, group:'today', createdAt:Date.now(), updatedAt:Date.now() },
];

export default function App() {
  // PWA: простой SW, чтобы ставилось на экран (можно пропустить)
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      const sw = `self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open('notes3-v1').then(c=>c.addAll(['./'])))});self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))})`;
      const blob = new Blob([sw], { type:'text/javascript' });
      const url = URL.createObjectURL(blob);
      navigator.serviceWorker.register(url).catch(()=>{});
    }
  }, []);

  const [tasks, setTasks] = useState<Task[]>(() => {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) return JSON.parse(raw) as Task[]; } catch {}
    return emptyState;
  });
  const [hideDone, setHideDone] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newGroup, setNewGroup] = useState<Group>('today');
  const [syncKey, setSyncKey] = useState<string>(() => localStorage.getItem(LS_SYNC_KEY) || '');
  const [syncStatus, setSyncStatus] = useState<'idle'|'pulling'|'pushing'|'error'>('idle');
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(tasks)); } catch {} }, [tasks]);
  useEffect(() => { try { localStorage.setItem(LS_SYNC_KEY, syncKey); } catch {} }, [syncKey]);

  function pushSnapshot(note = 'auto') {
    try {
      const raw = localStorage.getItem(LS_HISTORY_KEY);
      const hist: any[] = raw ? JSON.parse(raw) : [];
      hist.unshift({ ts: Date.now(), note, tasks });
      while (hist.length > 50) hist.pop();
      localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(hist));
    } catch {}
  }
  useEffect(() => { pushSnapshot('auto'); }, []);

  useEffect(() => {
    const url = new URL(location.href);
    const k = url.hash.startsWith('#key=') ? decodeURIComponent(url.hash.slice(5)) : '';
    if (k && k !== syncKey) setSyncKey(k);
  }, []);

  const addTask = () => {
    const title = newTitle.trim(); if (!title) return;
    const now = Date.now();
    setTasks(t => [{ id: uid(), title, done:false, group:newGroup, createdAt:now, updatedAt:now }, ...t]);
    setNewTitle(''); pushSnapshot('add');
  };
  const toggleDone = (id:string) => { setTasks(t => t.map(x => x.id===id?{...x,done:!x.done,updatedAt:Date.now()}:x)); pushSnapshot('toggle'); };
  const deleteTask = (id:string) => { setTasks(t => t.filter(x => x.id!==id)); pushSnapshot('delete'); };
  const renameTask = (id:string, title:string) => { setTasks(t => t.map(x => x.id===id?{...x,title,updatedAt:Date.now()}:x)); pushSnapshot('rename'); };
  const moveTaskTo = (id:string, group:Group) => { setTasks(t => t.map(x => x.id===id?{...x,group,updatedAt:Date.now()}:x)); pushSnapshot('move'); };

  const groups = useMemo(() => ({
    big: tasks.filter(t => t.group==='big' && (!hideDone || !t.done)),
    middle: tasks.filter(t => t.group==='middle' && (!hideDone || !t.done)),
    today: tasks.filter(t => t.group==='today' && (!hideDone || !t.done)),
  }), [tasks, hideDone]);

  // DnD
  const dragId = useRef<string|null>(null);
  const onDragStart = (e: React.DragEvent, id: string) => { dragId.current = id; e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; };
  const onDropGroup = (e: React.DragEvent, g: Group) => { e.preventDefault(); const id = dragId.current || e.dataTransfer.getData('text/plain'); if (id) moveTaskTo(id,g); dragId.current=null; };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };

  // === Cloud sync (Supabase) ===
  function mergeTasks(local: Task[], remote: Task[]): Task[] {
    const byId = new Map<string,Task>();
    [...local, ...remote].forEach(t => { const p = byId.get(t.id); if (!p || t.updatedAt > p.updatedAt) byId.set(t.id,t); });
    return Array.from(byId.values()).sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  async function pullFromCloud() {
    if (!syncKey || !supabase) return;
    try {
      setSyncStatus('pulling');
      const { data, error } = await supabase.from('boards').select('data').eq('key', syncKey).maybeSingle();
      if (error) throw error;
      if (data?.data) {
        const remoteTasks = (data.data.tasks || []) as Task[];
        setTasks(local => mergeTasks(local, remoteTasks));
      }
      setSyncStatus('idle');
    } catch (e) { console.error(e); setSyncStatus('error'); }
  }
  const pushDebounce = useRef<number|null>(null);
  useEffect(() => {
    if (!syncKey || !supabase) return;
    setSyncStatus('pushing');
    if (pushDebounce.current) window.clearTimeout(pushDebounce.current);
    pushDebounce.current = window.setTimeout(async () => {
      try {
        const payload = { tasks };
        const { error } = await supabase.from('boards').upsert({ key: syncKey, data: payload }).select();
        if (error) throw error;
        setSyncStatus('idle');
      } catch (e) { console.error(e); setSyncStatus('error'); }
    }, 500);
  }, [tasks, syncKey]);

  useEffect(() => { if (syncKey) pullFromCloud(); }, [syncKey]);

  return (
    <div className="min-h-screen w-full" style={{ background:'#fafafa', color:'#111' }}>
      <header style={{ position:'sticky', top:0, zIndex:10, borderBottom:'1px solid #e5e5e5', background:'rgba(255,255,255,0.8)', backdropFilter:'blur(8px)' }}>
        <div style={{ maxWidth:960, margin:'0 auto', padding:16, display:'flex', flexWrap:'wrap', gap:8, alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ height:32, width:32, borderRadius:16, background:'#111', color:'#fff', display:'grid', placeItems:'center', fontWeight:600 }}>N</div>
            <div>
              <div style={{ fontSize:18, fontWeight:600 }}>Tri-Group Notes</div>
              <div style={{ fontSize:12, color:'#666' }}>Big • Middle • Today — drag to triage, check to complete</div>
            </div>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:14 }}>
              <input type="checkbox" checked={hideDone} onChange={e=>setHideDone(e.target.checked)} /> Hide completed
            </label>
            <button onClick={()=>{
              const payload = { version:1, exportedAt:new Date().toISOString(), tasks };
              const blob = new Blob([JSON.stringify(payload,null,2)], { type:'application/json' });
              const url = URL.createObjectURL(blob); const a = document.createElement('a');
              a.href=url; a.download=`tri-notes-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
            }} style={{ border:'1px solid #ddd', borderRadius:12, padding:'6px 10px', background:'#fff' }}>Export</button>
            <label style={{ border:'1px solid #ddd', borderRadius:12, padding:'6px 10px', background:'#fff', cursor:'pointer' }}>
              Import
              <input type="file" accept="application/json" style={{ display:'none' }} onChange={e=>{
                const f = e.target.files?.[0]; if (!f) return;
                const r = new FileReader(); r.onload = () => {
                  try {
                    const obj = JSON.parse(String(r.result||'{}'));
                    if (Array.isArray(obj.tasks)) {
                      const now = Date.now();
                      const normalized: Task[] = obj.tasks.map((t:any)=>({
                        id: t.id || uid(),
                        title: String(t.title||'Untitled'),
                        done: !!t.done,
                        group: (t.group as Group) || 'today',
                        createdAt: Number(t.createdAt||now),
                        updatedAt: Number(t.updatedAt||now),
                      }));
                      setTasks(cur => mergeTasks(cur, normalized));
                    } else alert('Invalid JSON');
                  } catch { alert('Invalid JSON'); }
                }; r.readAsText(f);
              }} />
            </label>
            <button onClick={()=>{ const url = `${location.origin}${location.pathname}#key=${encodeURIComponent(syncKey||'archi')}`; navigator.clipboard.writeText(url); }} style={{ border:'1px solid #ddd', borderRadius:12, padding:'6px 10px', background:'#fff' }}>Copy link</button>

            <div style={{ display:'flex', alignItems:'center', gap:6, border:'1px solid #ddd', borderRadius:12, padding:'4px 6px' }}>
              <span style={{ color:'#666', fontSize:12 }}>Sync</span>
              <input value={syncKey} onChange={e=>setSyncKey(e.target.value.trim())} placeholder="key (e.g. archi)" style={{ width:120, border:'1px solid #ddd', borderRadius:8, padding:'4px 6px', fontSize:12 }} />
              <button onClick={pullFromCloud} style={{ background:'#111', color:'#fff', borderRadius:8, padding:'4px 8px', fontSize:12 }}>Pull</button>
              <span style={{ borderRadius:999, padding:'2px 8px', fontSize:12, background: supabase ? (syncStatus==='idle'?'#dcfce7':syncStatus==='pushing'?'#dbeafe':syncStatus==='pulling'?'#fef3c7':'#fee2e2') : '#f5f5f5' }}>
                {supabase ? (syncStatus==='idle'?'synced':syncStatus) : 'cloud off'}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div style={{ maxWidth:960, margin:'0 auto', padding:16, display:'flex', gap:8 }}>
        <input value={newTitle} onChange={e=>setNewTitle(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addTask()} placeholder="Add a task…" style={{ flex:1, border:'1px solid #ddd', borderRadius:12, padding:'8px 12px' }} />
        <select value={newGroup} onChange={e=>setNewGroup(e.target.value as Group)} style={{ border:'1px solid #ddd', borderRadius:12, padding:'8px 12px' }}>
          <option value="today">Today</option><option value="middle">Middle</option><option value="big">Big</option>
        </select>
        <button onClick={addTask} style={{ background:'#111', color:'#fff', borderRadius:12, padding:'8px 16px' }}>Add</button>
      </div>

      <main style={{ maxWidth:960, margin:'0 auto', padding:'0 16px 48px 16px' }}>
        {(['big','middle','today'] as Group[]).map(g=>(
          <section key={g} onDrop={e=>onDropGroup(e,g)} onDragOver={onDragOver} style={{ border:'1px solid #e5e5e5', background:'#fff', borderRadius:16, padding:12, marginBottom:16, boxShadow:'0 1px 3px rgba(0,0,0,.04)' }}>
            <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
              <h2 style={{ textTransform:'uppercase', fontSize:12, letterSpacing:.6, color:'#666', fontWeight:600 }}>{groupLabel[g]}</h2>
              <span style={{ fontSize:12, color:'#999' }}>{tasks.filter(t=>t.group===g).length}</span>
            </header>
            <div>
              {groups[g].length===0 && <div style={{ border:'1px dashed #ddd', borderRadius:12, padding:16, textAlign:'center', color:'#999', fontSize:14 }}>Drop here to move tasks into {groupLabel[g]}</div>}
              {groups[g].map(t=>(
                <TaskCard key={t.id} task={t} onToggle={()=>toggleDone(t.id)} onDelete={()=>deleteTask(t.id)} onRename={(title)=>renameTask(t.id,title)} onDragStart={(e)=>onDragStart(e,t.id)} />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function TaskCard({ task, onToggle, onDelete, onRename, onDragStart }:{ task:Task; onToggle:()=>void; onDelete:()=>void; onRename:(title:string)=>void; onDragStart:(e:React.DragEvent)=>void; }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const inputRef = useRef<HTMLInputElement|null>(null);
  useEffect(()=>{ if (editing) inputRef.current?.focus(); },[editing]);
  const commit = () => { const v = value.trim(); if (!v) { setValue(task.title); setEditing(false); return; } if (v !== task.title) onRename(v); setEditing(false); };

  return (
    <div draggable onDragStart={onDragStart} style={{ display:'flex', alignItems:'center', gap:8, border:'1px solid #e5e5e5', borderRadius:12, padding:12, marginBottom:8, background: task.done?'#fafafa':'#fff', opacity: task.done?.8:1 } as any}>
      <input type="checkbox" checked={task.done} onChange={onToggle} />
      {editing ? (
        <input ref={inputRef} value={value} onChange={e=>setValue(e.target.value)} onBlur={commit} onKeyDown={e=>{ if(e.key==='Enter') commit(); if(e.key==='Escape') setEditing(false); }} style={{ flex:1, border:'1px solid #ddd', borderRadius:8, padding:'6px 8px', fontSize:14 }} />
      ) : (
        <button onDoubleClick={()=>setEditing(true)} style={{ flex:1, textAlign:'left', fontSize:14, color: task.done?'#888':'#111', textDecoration: task.done?'line-through':'none', background:'none', border:'none', padding:0 }}>
          {task.title}
        </button>
      )}
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <button onClick={()=>setEditing(true)} style={{ fontSize:12, padding:'4px 8px', borderRadius:8, border:'1px solid #eee' }}>Edit</button>
        <button onClick={onDelete} style={{ fontSize:12, padding:'4px 8px', borderRadius:8, border:'1px solid #fee', color:'#b91c1c', background:'#fff5f5' }}>Delete</button>
        <span title="Drag" style={{ fontSize:12, color:'#999', userSelect:'none' }}>⇅</span>
      </div>
    </div>
  );
}

