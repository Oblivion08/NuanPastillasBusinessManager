"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, query, runTransaction, setDoc, where } from "firebase/firestore";
import { auth, db, firebaseConfigured } from "@/lib/firebase";

type Product = { id: number; name: string; flavor: string; cost: number; price: number; stock: number; lowStock: number; active: number };
type Sale = { id: number; saleDate: string; productId: number; productName: string; quantity: number; unitPrice: number; unitCost: number; discount: number; total: number; profit: number; payment: string; channel: string; customerName?: string; dueDate?: string; amountPaid?: number; paymentStatus?: "unpaid" | "partial" | "paid"; settledDate?: string };
type Expense = { id: number; expenseDate: string; category: string; description: string; amount: number; payment: string };
type Settings = { businessName: string; ownerName: string; contactNumber: string; defaultLowStock: number; monthlyPackGoal: number; currency: string };
type Data = { products: Product[]; sales: Sale[]; expenses: Expense[]; settings: Settings };
type Tab = "Dashboard" | "Sales" | "Receivables" | "Expenses" | "Products" | "Inventory" | "Reports" | "Settings";
type Stats = { sales: number; cost: number; gross: number; expenses: number; net: number; packs: number; stock: number; low: number };

const money = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);
const isRecognizedSale = (sale: Sale) => sale.payment !== "Credit" || sale.paymentStatus === "paid";
const recognizedDate = (sale: Sale) => sale.payment === "Credit" ? sale.settledDate || sale.saleDate : sale.saleDate;
const DEFAULT_SETTINGS: Settings = { businessName: "NUAN Pastillas", ownerName: "Jenny Lou", contactNumber: "", defaultLowStock: 10, monthlyPackGoal: 200, currency: "PHP" };

const nav: { label: Tab; icon: string }[] = [
  { label: "Dashboard", icon: "⌂" }, { label: "Sales", icon: "₱" }, { label: "Receivables", icon: "◷" }, { label: "Expenses", icon: "↗" },
  { label: "Products", icon: "▣" }, { label: "Inventory", icon: "▤" }, { label: "Reports", icon: "⌁" },
  { label: "Settings", icon: "⚙" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [data, setData] = useState<Data>({ products: [], sales: [], expenses: [], settings: DEFAULT_SETTINGS });
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"sale" | "editSale" | "receivablePayment" | "expense" | "editExpense" | "product" | "stock" | "edit" | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingSale, setEditingSale] = useState<Sale | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [toast, setToast] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const productSnap = await getDocs(collection(db, "products"));
      if (productSnap.empty) {
        const seed = [
          { id:1,name:"Milk Pastillas",flavor:"Milk",cost:113,price:130,stock:24,lowStock:10,active:1 },
          { id:2,name:"Ube Pastillas",flavor:"Ube",cost:113,price:130,stock:18,lowStock:10,active:1 },
          { id:3,name:"Mini Milk Pastillas",flavor:"Milk",cost:55,price:70,stock:12,lowStock:8,active:1 },
          { id:4,name:"Mini Ube Pastillas",flavor:"Ube",cost:55,price:70,stock:9,lowStock:8,active:1 },
        ];
        await Promise.all(seed.map(p => setDoc(doc(db,"products",String(p.id)),p)));
      }
      const [products,sales,expenses,settingsDoc] = await Promise.all([getDocs(collection(db,"products")),getDocs(collection(db,"sales")),getDocs(collection(db,"expenses")),getDoc(doc(db,"settings","main"))]);
      const settings = settingsDoc.exists() ? { ...DEFAULT_SETTINGS, ...settingsDoc.data() } as Settings : DEFAULT_SETTINGS;
      if (!settingsDoc.exists()) await setDoc(doc(db,"settings","main"),settings);
      setData({ products:products.docs.map(x=>x.data() as Product).filter(p=>p.active), sales:sales.docs.map(x=>x.data() as Sale).sort((a,b)=>b.id-a.id), expenses:expenses.docs.map(x=>x.data() as Expense).sort((a,b)=>b.id-a.id), settings });
    }
    catch { setToast("Hindi ma-load ang records. Pakisubukan ulit."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => auth.onAuthStateChanged(current => { setUser(current); setAuthReady(true); if (current) void load(); else setLoading(false); }), [load]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 3200); return () => clearTimeout(t); }, [toast]);

  const stats = useMemo(() => {
    const todaysSales = data.sales.filter(s => isRecognizedSale(s) && recognizedDate(s) === today());
    const todaysExpenses = data.expenses.filter(e => e.expenseDate === today());
    const sales = todaysSales.reduce((n, s) => n + s.total, 0);
    const cost = todaysSales.reduce((n, s) => n + s.unitCost * s.quantity, 0);
    const gross = todaysSales.reduce((n, s) => n + s.profit, 0);
    const expenses = todaysExpenses.reduce((n, e) => n + e.amount, 0);
    return { sales, cost, gross, expenses, net: gross - expenses, packs: todaysSales.reduce((n, s) => n + s.quantity, 0), stock: data.products.reduce((n, p) => n + p.stock, 0), low: data.products.filter(p => p.stock <= p.lowStock).length };
  }, [data]);

  async function submit(kind: string, payload: Record<string, FormDataEntryValue>) {
    try {
      const value = Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,String(v)]));
      if (kind === "sale") {
        const productId=Number(value.productId),qty=Number(value.quantity),discount=Number(value.discount||0),saleId=Date.now();
        await runTransaction(db,async tx=>{const ref=doc(db,"products",String(productId)),snap=await tx.get(ref);if(!snap.exists())throw new Error("Product not found.");const p=snap.data() as Product;if(p.stock<qty)throw new Error(`Only ${p.stock} pack(s) are in stock.`);const unitCost=value.unitCost===""?p.cost:Number(value.unitCost);if(unitCost<0)throw new Error("Cost cannot be negative.");const total=qty*p.price-discount,isCredit=value.payment==="Credit";if(isCredit&&(!value.customerName||!value.dueDate))throw new Error("Customer name and due date are required for credit sales.");tx.update(ref,{stock:p.stock-qty});tx.set(doc(db,"sales",String(saleId)),{id:saleId,saleDate:value.date,productId,productName:p.name,quantity:qty,unitPrice:p.price,unitCost,discount,total,profit:total-qty*unitCost,payment:value.payment,channel:value.channel,customerName:isCredit?value.customerName:"",dueDate:isCredit?value.dueDate:"",amountPaid:isCredit?0:total,paymentStatus:isCredit?"unpaid":"paid",settledDate:isCredit?"":value.date});});
      } else if (kind === "editSale") {
        const saleId=Number(value.saleId),oldProductId=Number(value.oldProductId),oldQuantity=Number(value.oldQuantity),productId=Number(value.productId),qty=Number(value.quantity),discount=Number(value.discount||0);
        await runTransaction(db,async tx=>{
          const saleRef=doc(db,"sales",String(saleId)),oldProductRef=doc(db,"products",String(oldProductId)),newProductRef=doc(db,"products",String(productId));
          const refs=oldProductId===productId?[oldProductRef]:[oldProductRef,newProductRef];
          const snaps=await Promise.all(refs.map(ref=>tx.get(ref)));
          if(snaps.some(snap=>!snap.exists()))throw new Error("Product not found.");
          const oldProduct=snaps[0].data() as Product,newProduct=(oldProductId===productId?oldProduct:snaps[1].data()) as Product;
          if(oldProductId===productId){const nextStock=oldProduct.stock+oldQuantity-qty;if(nextStock<0)throw new Error(`Only ${oldProduct.stock+oldQuantity} pack(s) are available.`);tx.update(oldProductRef,{stock:nextStock});}
          else {if(newProduct.stock<qty)throw new Error(`Only ${newProduct.stock} pack(s) are in stock.`);tx.update(oldProductRef,{stock:oldProduct.stock+oldQuantity});tx.update(newProductRef,{stock:newProduct.stock-qty});}
          const original=data.sales.find(s=>s.id===saleId),unitPrice=oldProductId===productId&&original?original.unitPrice:newProduct.price,unitCost=Number(value.unitCost);if(unitCost<0)throw new Error("Cost cannot be negative.");const total=qty*unitPrice-discount,isCredit=value.payment==="Credit";if(isCredit&&(!value.customerName||!value.dueDate))throw new Error("Customer name and due date are required for credit sales.");const previousPaid=original?.payment==="Credit"?(original.amountPaid||0):0,amountPaid=isCredit?Math.min(previousPaid,total):total,paymentStatus=amountPaid>=total?"paid":amountPaid>0?"partial":"unpaid";
          tx.set(saleRef,{id:saleId,saleDate:value.date,productId,productName:newProduct.name,quantity:qty,unitPrice,unitCost,discount,total,profit:total-qty*unitCost,payment:value.payment,channel:value.channel,customerName:isCredit?value.customerName:"",dueDate:isCredit?value.dueDate:"",amountPaid,paymentStatus,settledDate:isCredit?(paymentStatus==="paid"?original?.settledDate||value.date:""):value.date});
        });
      } else if (kind === "receivablePayment") {
        const saleId=Number(value.saleId),amount=Number(value.amount),paymentId=Date.now();if(amount<=0)throw new Error("Payment amount must be greater than zero.");
        await runTransaction(db,async tx=>{const saleRef=doc(db,"sales",String(saleId)),snap=await tx.get(saleRef);if(!snap.exists())throw new Error("Credit sale not found.");const sale=snap.data() as Sale,paid=sale.amountPaid||0,balance=sale.total-paid;if(amount>balance)throw new Error(`Payment cannot exceed the ${money.format(balance)} balance.`);const amountPaid=paid+amount,paymentStatus=amountPaid>=sale.total?"paid":"partial";tx.update(saleRef,{amountPaid,paymentStatus,settledDate:paymentStatus==="paid"?value.paymentDate:""});tx.set(doc(db,"receivablePayments",String(paymentId)),{id:paymentId,saleId,customerName:sale.customerName||"",amount,paymentDate:value.paymentDate,method:value.method});});
      } else if (kind === "expense") { const id=Date.now(); await setDoc(doc(db,"expenses",String(id)),{id,expenseDate:value.date,category:value.category,description:value.description,amount:Number(value.amount),payment:value.payment});
      } else if (kind === "editExpense") { const id=Number(value.expenseId); await setDoc(doc(db,"expenses",String(id)),{id,expenseDate:value.date,category:value.category,description:value.description,amount:Number(value.amount),payment:value.payment});
      } else if (kind === "product") { const id=Date.now(); await setDoc(doc(db,"products",String(id)),{id,name:value.name,flavor:value.flavor,cost:Number(value.cost),price:Number(value.price),stock:Number(value.stock),lowStock:Number(value.lowStock),active:1});
      } else if (kind === "edit") { await setDoc(doc(db,"products",value.productId),{id:Number(value.productId),name:value.name,flavor:value.flavor,cost:Number(value.cost),price:Number(value.price),lowStock:Number(value.lowStock)},{merge:true});
      } else if (kind === "stock") { await runTransaction(db,async tx=>{const ref=doc(db,"products",value.productId),snap=await tx.get(ref);if(!snap.exists())throw new Error("Product not found.");const p=snap.data() as Product,quantity=Number(value.quantity),delta=value.adjustmentType==="Deduct"?-quantity:quantity,next=p.stock+delta;if(next<0)throw new Error(`Cannot deduct ${quantity}. Only ${p.stock} pack(s) are in stock.`);tx.update(ref,{stock:next});});
      } else if (kind === "settings") { await setDoc(doc(db,"settings","main"),{businessName:value.businessName,ownerName:value.ownerName,contactNumber:value.contactNumber,defaultLowStock:Number(value.defaultLowStock),monthlyPackGoal:Number(value.monthlyPackGoal),currency:"PHP"}); }
      setModal(null); setEditingProduct(null); setEditingSale(null); setEditingExpense(null); setToast("Saved! Updated na ang dashboard."); await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "Hindi na-save ang entry."); }
  }

  async function login(e:FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget);try{setLoading(true);await signInWithEmailAndPassword(auth,String(f.get("email")),String(f.get("password")));}catch{setLoading(false);setToast("Mali ang email o password.");}}

  async function deleteSale(sale: Sale) {
    if (!window.confirm(`Delete this ${sale.productName} sale? ${sale.quantity} pack(s) will be returned to inventory.`)) return;
    try {
      const paymentSnap=await getDocs(query(collection(db,"receivablePayments"),where("saleId","==",sale.id)));
      await runTransaction(db,async tx=>{const saleRef=doc(db,"sales",String(sale.id)),productRef=doc(db,"products",String(sale.productId));const [saleSnap,productSnap]=await Promise.all([tx.get(saleRef),tx.get(productRef)]);if(!saleSnap.exists())throw new Error("Transaction no longer exists.");if(!productSnap.exists())throw new Error("Product not found; inventory cannot be restored.");const savedSale=saleSnap.data() as Sale,product=productSnap.data() as Product;tx.update(productRef,{stock:product.stock+savedSale.quantity});tx.delete(saleRef);paymentSnap.docs.forEach(payment=>tx.delete(payment.ref));});
      setToast("Transaction deleted. Quantity returned to inventory."); await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "Hindi ma-delete ang sale."); }
  }

  async function deleteExpense(expense: Expense) {
    if (!window.confirm(`Delete the ${money.format(expense.amount)} ${expense.category} expense?`)) return;
    try { await runTransaction(db,async tx=>{tx.delete(doc(db,"expenses",String(expense.id)));});setToast("Expense deleted. Dashboard and reports updated.");await load(); }
    catch (error) { setToast(error instanceof Error ? error.message : "Hindi ma-delete ang expense."); }
  }

  if (!firebaseConfigured) return <div className="login-screen"><div className="login-card"><h1>NUAN Business Manager</h1><p>Firebase setup is required before you can sign in and save business data.</p><p>Add the six <code>NEXT_PUBLIC_FIREBASE_*</code> values in Vercel, then redeploy.</p></div></div>;
  if (!authReady) return <div className="login-screen"><div className="loading">Preparing NUAN Business Manager…</div></div>;
  if (!user) return <div className="login-screen"><form className="login-card" onSubmit={login}><div className="brand-mark">N</div><p className="eyebrow">NUAN PASTILLAS</p><h1>Business Manager</h1><p>Sign in to view your private sales, inventory, expenses, and profit records.</p><label>Email<input type="email" name="email" required autoComplete="email"/></label><label>Password<input type="password" name="password" required autoComplete="current-password"/></label><button className="primary" disabled={loading}>{loading?"Signing in…":"Sign In"}</button></form>{toast&&<div className="toast">{toast}</div>}</div>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">N</div><div><strong>NUAN</strong><span>{data.settings.businessName}</span></div></div>
        <nav>{nav.map(n => <button key={n.label} className={tab === n.label ? "active" : ""} onClick={() => setTab(n.label)}><i>{n.icon}</i>{n.label}</button>)}</nav>
        <div className="sidebar-footer"><div className="avatar">JL</div><div><strong>{data.settings.ownerName}</strong><span>Business Owner</span></div><button aria-label="Sign out" onClick={() => void signOut(auth)}>↪</button></div>
      </aside>

      <main>
        <header><div><p className="eyebrow">NUAN PASTILLAS</p><h1>{tab}</h1><p>{tab === "Dashboard" ? "Here’s how your business is doing today." : `Manage your ${tab.toLowerCase()} records.`}</p></div><div className="header-actions"><button className="icon-button" aria-label="Open settings" onClick={() => setTab("Settings")}>⚙</button><button className="primary" onClick={() => setModal("sale")}>＋ Add Sale</button></div></header>
        {loading ? <div className="loading">Loading your business records…</div> : <Content tab={tab} data={data} stats={stats} open={setModal} onEdit={p => { setEditingProduct(p); setModal("edit"); }} onEditSale={s => { setEditingSale(s); setModal("editSale"); }} onDeleteSale={deleteSale} onEditExpense={e => { setEditingExpense(e); setModal("editExpense"); }} onDeleteExpense={deleteExpense} onStockProduct={p => { setEditingProduct(p); setModal("stock"); }} onPayment={s => { setEditingSale(s); setModal("receivablePayment"); }} save={submit} />}
      </main>

      <div className="bottom-nav">{nav.slice(0, 5).map(n => <button key={n.label} className={tab === n.label ? "active" : ""} onClick={() => setTab(n.label)}><b>{n.icon}</b><span>{n.label}</span></button>)}</div>
      {modal && <EntryModal type={modal} products={data.products} product={editingProduct} sale={editingSale} expense={editingExpense} defaultLowStock={data.settings.defaultLowStock} close={() => { setModal(null); setEditingProduct(null); setEditingSale(null); setEditingExpense(null); }} submit={submit} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Content({ tab, data, stats, open, onEdit, onEditSale, onDeleteSale, onEditExpense, onDeleteExpense, onStockProduct, onPayment, save }: { tab: Tab; data: Data; stats: Stats; open: (x: "sale" | "expense" | "product" | "stock") => void; onEdit: (p: Product) => void; onEditSale: (s: Sale) => void; onDeleteSale: (s: Sale) => Promise<void>; onEditExpense: (e: Expense) => void; onDeleteExpense: (e: Expense) => Promise<void>; onStockProduct: (p: Product) => void; onPayment: (s: Sale) => void; save: (kind: string, p: Record<string, FormDataEntryValue>) => Promise<void> }) {
  if (tab === "Dashboard") return <Dashboard data={data} stats={stats} open={open} />;
  if (tab === "Sales") return <ListPage title="Sales history" action="Add Sale" onAction={() => open("sale")}><SalesTable sales={data.sales.filter(isRecognizedSale).sort((a,b)=>recognizedDate(b).localeCompare(recognizedDate(a))||b.id-a.id)} onEdit={onEditSale} onDelete={onDeleteSale} /></ListPage>;
  if (tab === "Receivables") return <Receivables sales={data.sales} onPayment={onPayment} onEdit={onEditSale} onDelete={onDeleteSale} />;
  if (tab === "Expenses") return <ListPage title="Expense history" action="Add Expense" onAction={() => open("expense")}><ExpenseTable expenses={data.expenses} onEdit={onEditExpense} onDelete={onDeleteExpense} /></ListPage>;
  if (tab === "Products") return <ListPage title="Your products" action="Add Product" onAction={() => open("product")}><ProductGrid products={data.products} onEdit={onEdit} /></ListPage>;
  if (tab === "Inventory") return <ListPage title="Current inventory" action="Update Stock" onAction={() => open("stock")}><InventoryTable products={data.products} onUpdate={onStockProduct} /></ListPage>;
  if (tab === "Reports") return <Reports data={data} />;
  return <SettingsPage settings={data.settings} save={save} />;
}

function Dashboard({ data, stats, open }: { data: Data; stats: Stats; open: (x: "sale" | "expense" | "product" | "stock") => void }) {
  const monthKey=today().slice(0,7),monthlyPacks=data.sales.filter(s=>isRecognizedSale(s)&&recognizedDate(s).startsWith(monthKey)).reduce((n,s)=>n+s.quantity,0),goal=Math.max(data.settings.monthlyPackGoal,1),goalPercent=Math.min(100,monthlyPacks/goal*100),remaining=Math.max(0,goal-monthlyPacks);
  const openCredits=data.sales.filter(s=>s.payment==="Credit"&&Math.max(0,s.total-(s.amountPaid||0))>0),creditReleased=openCredits.reduce((n,s)=>n+s.total,0),creditCollected=openCredits.reduce((n,s)=>n+(s.amountPaid||0),0),receivables=creditReleased-creditCollected,overdue=openCredits.filter(s=>Boolean(s.dueDate)&&s.dueDate!<today()).length;
  const cards = [
    ["Today’s Sales", stats.sales, "gold", "₱"], ["Gross Profit", stats.gross, "purple", "↗"], ["Other Expenses", stats.expenses, "rose", "↘"], ["Net Profit", stats.net, "green", "◎"],
  ];
  return <>
    <section className="summary-grid">{cards.map(([label, value, tone, icon]) => <article className={`summary ${tone}`} key={String(label)}><div className="summary-top"><span>{label}</span><i>{icon}</i></div><strong>{money.format(Number(value))}</strong><small>Updated in real time</small></article>)}</section>
    <section className="mini-grid"><article><span>Packs sold today</span><strong>{stats.packs}</strong></article><article><span>Total inventory</span><strong>{stats.stock}</strong></article><article className={stats.low ? "warning" : ""}><span>Low-stock products</span><strong>{stats.low}</strong></article><article><span>Product cost today</span><strong>{money.format(stats.cost)}</strong></article></section>
    <section className="monthly-goal panel"><div><p className="eyebrow">MONTHLY PACK GOAL</p><h2>{monthlyPacks} of {goal} packs</h2><span>{remaining ? `${remaining} packs remaining this month` : "Goal achieved—great work!"}</span></div><strong>{Math.round(monthlyPacks/goal*100)}%</strong><div className="goal-track"><i style={{width:`${goalPercent}%`}}/></div></section>
    <section className="panel receivable-balance"><div className="receivable-balance-head"><div><p className="eyebrow">ACCOUNTS RECEIVABLE BALANCE</p><h2>{money.format(receivables)} outstanding</h2><span>Collected partial payments + outstanding balance = total open credit value</span></div><div className={overdue?"receivable-alert danger":"receivable-alert"}><strong>{openCredits.length}</strong><small>open account{openCredits.length===1?"":"s"}</small>{overdue?<em>{overdue} overdue</em>:null}</div></div><div className="receivable-equation"><article><span>Collected from open credits</span><b>{money.format(creditCollected)}</b></article><i>＋</i><article><span>Outstanding receivables</span><b>{money.format(receivables)}</b></article><i>＝</i><article className="total"><span>Total open credit value</span><b>{money.format(creditReleased)}</b></article></div></section>
    <section className="dashboard-grid">
      <article className="panel chart-panel"><div className="panel-title"><div><h2>7-day business trend</h2><p>Daily sales, gross profit, and expenses</p></div><span className="chip">Last 7 days</span></div><TrendChart data={data} days={7} /></article>
      <article className="panel quick"><div className="panel-title"><div><h2>Quick actions</h2><p>Record today’s activity</p></div></div><button onClick={() => open("sale")}><i>₱</i><span><b>Record a sale</b><small>Automatically deduct stock</small></span><em>›</em></button><button onClick={() => open("expense")}><i>↗</i><span><b>Add an expense</b><small>Track operating costs</small></span><em>›</em></button><button onClick={() => open("stock")}><i>▤</i><span><b>Update inventory</b><small>Add newly received packs</small></span><em>›</em></button></article>
      <article className="panel recent"><div className="panel-title"><div><h2>Recent sales</h2><p>Your latest paid transactions</p></div></div><SalesTable sales={data.sales.filter(isRecognizedSale).sort((a,b)=>recognizedDate(b).localeCompare(recognizedDate(a))||b.id-a.id).slice(0, 5)} /></article>
      <article className="panel stock-card"><div className="panel-title"><div><h2>Inventory status</h2><p>Stock level per product</p></div></div>{data.products.map(p => <div className="stock-row" key={p.id}><div><b>{p.name}</b><small>{p.flavor}</small></div><div className="stock-track"><span style={{ width: `${Math.min(100, p.stock / Math.max(p.lowStock * 4, 1) * 100)}%` }} /></div><strong className={p.stock <= p.lowStock ? "low" : ""}>{p.stock} packs</strong></div>)}</article>
    </section>
  </>;
}

function ListPage({ title, action, onAction, children }: { title: string; action: string; onAction: () => void; children: React.ReactNode }) { return <section className="panel list-page"><div className="list-head"><div><h2>{title}</h2><p>Searchable, up-to-date business records</p></div><button className="primary" onClick={onAction}>＋ {action}</button></div>{children}</section>; }
function SalesTable({ sales, onEdit, onDelete }: { sales: Sale[]; onEdit?: (s: Sale) => void; onDelete?: (s: Sale) => Promise<void> }) { const hasActions=Boolean(onEdit||onDelete);return <div className="table-wrap"><table><thead><tr><th>Date</th><th>Product</th><th>Qty</th><th>Sales</th><th>Profit</th><th>Payment</th>{hasActions?<th>Actions</th>:null}</tr></thead><tbody>{sales.length ? sales.map(s => <tr key={s.id}><td>{recognizedDate(s)}{s.payment==="Credit"?<small>Credit settled</small>:null}</td><td><b>{s.productName}</b><small>{s.channel}</small></td><td>{s.quantity}</td><td>{money.format(s.total)}</td><td className="positive">{money.format(s.profit)}</td><td><span className="tag">{s.payment}</span>{s.payment==="Credit"?<small>paid</small>:null}</td>{hasActions?<td><div className="row-actions">{onEdit?<button className="edit-button" onClick={()=>onEdit(s)}>✎ Edit</button>:null}{onDelete?<button className="delete-button" onClick={()=>void onDelete(s)}>Delete</button>:null}</div></td>:null}</tr>) : <tr><td colSpan={hasActions?7:6} className="empty">No paid sales yet. Credit transactions stay in Receivables until fully paid.</td></tr>}</tbody></table></div>; }
function Receivables({ sales, onPayment, onEdit, onDelete }: { sales: Sale[]; onPayment: (s: Sale) => void; onEdit: (s: Sale) => void; onDelete: (s: Sale) => Promise<void> }) { const rows=sales.filter(s=>s.payment==="Credit"&&Math.max(0,s.total-(s.amountPaid||0))>0),outstanding=rows.reduce((n,s)=>n+Math.max(0,s.total-(s.amountPaid||0)),0);return <section className="panel list-page"><div className="list-head"><div><h2>Accounts receivable</h2><p>Credit transactions stay here until fully paid</p></div><div className="receivable-total"><small>Total outstanding</small><strong>{money.format(outstanding)}</strong></div></div><div className="table-wrap"><table><thead><tr><th>Customer</th><th>Product released</th><th>Due date</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead><tbody>{rows.length?rows.map(s=>{const paid=s.amountPaid||0,balance=Math.max(0,s.total-paid),overdue=balance>0&&Boolean(s.dueDate)&&s.dueDate!<today();return <tr key={s.id}><td><b>{s.customerName||"Unnamed customer"}</b><small>{s.saleDate}</small></td><td>{s.productName}<small>{s.quantity} pack(s)</small></td><td>{s.dueDate||"—"}</td><td>{money.format(s.total)}</td><td className="positive">{money.format(paid)}</td><td className="negative"><b>{money.format(balance)}</b></td><td><span className={`status ${overdue?"danger":"pending"}`}>{overdue?"Overdue":paid>0?"Partial":"Unpaid"}</span></td><td><div className="row-actions"><button className="edit-button" onClick={()=>onPayment(s)}>＋ Payment</button><button className="edit-button" onClick={()=>onEdit(s)}>✎ Edit</button><button className="delete-button" onClick={()=>void onDelete(s)}>Delete</button></div></td></tr>}):<tr><td colSpan={8} className="empty">No outstanding receivables.</td></tr>}</tbody></table></div></section>; }
function ExpenseTable({ expenses, onEdit, onDelete }: { expenses: Expense[]; onEdit: (e: Expense) => void; onDelete: (e: Expense) => Promise<void> }) { return <div className="table-wrap"><table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Payment</th><th>Actions</th></tr></thead><tbody>{expenses.length ? expenses.map(e => <tr key={e.id}><td>{e.expenseDate}</td><td><span className="tag">{e.category}</span></td><td>{e.description}</td><td className="negative">{money.format(e.amount)}</td><td>{e.payment}</td><td><div className="row-actions"><button className="edit-button" onClick={()=>onEdit(e)}>✎ Edit</button><button className="delete-button" onClick={()=>void onDelete(e)}>Delete</button></div></td></tr>) : <tr><td colSpan={6} className="empty">No expenses recorded yet.</td></tr>}</tbody></table></div>; }
function ProductGrid({ products, onEdit }: { products: Product[]; onEdit: (p: Product) => void }) { return <div className="product-grid">{products.map(p => <article key={p.id}><div className={`product-art ${p.flavor.toLowerCase().includes("ube") ? "ube" : "milk"}`}>{p.flavor.toLowerCase().includes("ube") ? "U" : "M"}</div><div className="product-title"><div><h3>{p.name}</h3><p>{p.flavor} • Pastillas</p></div><button className="edit-button" onClick={() => onEdit(p)}>✎ Edit</button></div><div><span>Cost <b>{money.format(p.cost)}</b></span><span>Price <b>{money.format(p.price)}</b></span><span>Profit <b className="positive">{money.format(p.price - p.cost)}</b></span></div></article>)}</div>; }
function InventoryTable({ products, onUpdate }: { products: Product[]; onUpdate: (p: Product) => void }) { return <div className="table-wrap"><table><thead><tr><th>Product</th><th>Current stock</th><th>Low-stock level</th><th>Status</th><th>Stock value</th><th>Action</th></tr></thead><tbody>{products.map(p => <tr key={p.id}><td><b>{p.name}</b><small>{p.flavor}</small></td><td><b>{p.stock} packs</b></td><td>{p.lowStock} packs</td><td><span className={`status ${p.stock <= p.lowStock ? "danger" : "ok"}`}>{p.stock <= p.lowStock ? "Low stock" : "In stock"}</span></td><td>{money.format(p.stock * p.cost)}</td><td><button className="edit-button" onClick={()=>onUpdate(p)}>＋/− Stock</button></td></tr>)}</tbody></table></div>; }

function trendRows(data: Data, days: number) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - (days - 1 - i)); const date = d.toISOString().slice(0, 10);
    const sales = data.sales.filter(s => isRecognizedSale(s) && recognizedDate(s) === date); const expenses = data.expenses.filter(e => e.expenseDate === date);
    const revenue = sales.reduce((n,s)=>n+s.total,0), profit=sales.reduce((n,s)=>n+s.profit,0), expense=expenses.reduce((n,e)=>n+e.amount,0);
    return { date, label: d.toLocaleDateString("en-PH", { month:"short", day:"numeric" }), revenue, profit, expense, net:profit-expense };
  });
}

function TrendChart({ data, days }: { data: Data; days: number }) {
  const rows=trendRows(data,days), max=Math.max(...rows.flatMap(r=>[r.revenue,r.profit,r.expense]),1);
  return <><div className="trend-legend"><span><i className="sales-dot"/>Sales</span><span><i className="profit-dot"/>Gross profit</span><span><i className="expense-dot"/>Expenses</span></div><div className="trend-chart">{rows.map(r=><div className="trend-day" key={r.date}><div className="trend-bars"><i className="trend-sales" style={{height:`${Math.max(r.revenue?5:0,r.revenue/max*100)}%`}} title={`Sales: ${money.format(r.revenue)}`}/><i className="trend-profit" style={{height:`${Math.max(r.profit?5:0,r.profit/max*100)}%`}} title={`Gross profit: ${money.format(r.profit)}`}/><i className="trend-expense" style={{height:`${Math.max(r.expense?5:0,r.expense/max*100)}%`}} title={`Expenses: ${money.format(r.expense)}`}/></div><small>{r.label}</small></div>)}</div></>;
}

function Reports({ data }: { data: Data }) {
  const recognizedSales=data.sales.filter(isRecognizedSale),sales=recognizedSales.reduce((n,s)=>n+s.total,0), cost=recognizedSales.reduce((n,s)=>n+s.unitCost*s.quantity,0), exp=data.expenses.reduce((n,e)=>n+e.amount,0);
  const products=Object.values(recognizedSales.reduce<Record<string,{name:string;qty:number;revenue:number}>>((a,s)=>{a[s.productName]??={name:s.productName,qty:0,revenue:0};a[s.productName].qty+=s.quantity;a[s.productName].revenue+=s.total;return a;},{})).sort((a,b)=>b.qty-a.qty);
  const top=Math.max(...products.map(p=>p.qty),1);
  return <section className="reports wide"><div className="report-hero"><p>ALL-TIME PAID SALES SUMMARY</p><h2>{money.format(sales-cost-exp)}</h2><span>Credit transactions are included only after full payment</span></div><div className="report-grid"><article><span>Total paid sales</span><b>{money.format(sales)}</b></article><article><span>Cost of goods sold</span><b>{money.format(cost)}</b></article><article><span>Operating expenses</span><b>{money.format(exp)}</b></article><article><span>Total paid-sale packs</span><b>{recognizedSales.reduce((n,s)=>n+s.quantity,0)}</b></article></div><div className="report-panels"><article className="panel"><div className="panel-title"><div><h2>30-day trend</h2><p>Paid sales, gross profit, and expenses by day</p></div></div><TrendChart data={data} days={30}/></article><article className="panel"><div className="panel-title"><div><h2>Best-selling products</h2><p>Ranked by paid-sale packs</p></div></div><div className="ranking">{products.length?products.map((p,i)=><div key={p.name}><b>{i+1}</b><span><strong>{p.name}</strong><small>{p.qty} packs • {money.format(p.revenue)}</small></span><div><i style={{width:`${p.qty/top*100}%`}}/></div></div>):<p className="no-data">Product rankings will appear after your first paid sale.</p>}</div></article></div></section>;
}

function SettingsPage({ settings, save }: { settings: Settings; save: (kind:string,p:Record<string,FormDataEntryValue>)=>Promise<void> }) {
  function submitSettings(e:FormEvent<HTMLFormElement>){e.preventDefault();void save("settings",Object.fromEntries(new FormData(e.currentTarget)));}
  return <section className="settings-layout"><form className="panel settings-form" onSubmit={submitSettings}><div className="settings-heading"><div className="settings-icon">⚙</div><div><h2>Business profile</h2><p>These details personalize your NUAN dashboard.</p></div></div><label>Business name<input name="businessName" defaultValue={settings.businessName} required/></label><label>Owner name<input name="ownerName" defaultValue={settings.ownerName} required/></label><label>Contact number <small>Optional</small><input name="contactNumber" defaultValue={settings.contactNumber} placeholder="09XX XXX XXXX"/></label><div className="form-row"><label>Monthly sales goal (packs)<input type="number" min="1" name="monthlyPackGoal" defaultValue={settings.monthlyPackGoal} required/><small>Example: 200 packs per month</small></label><label>Default low-stock warning<input type="number" min="0" name="defaultLowStock" defaultValue={settings.defaultLowStock} required/></label></div><label>Currency<input value="Philippine Peso (PHP)" disabled/></label><button className="primary settings-save">Save Settings</button></form><aside><article className="panel settings-card"><span>◎</span><div><h3>Monthly pack goal</h3><p>Your Dashboard tracks monthly progress automatically and starts fresh each new month.</p></div></article><article className="panel settings-card"><span>₱</span><div><h3>Profit calculations</h3><p>Product cost changes apply only to future sales. Historical profits remain unchanged.</p></div></article><article className="panel settings-card"><span>▤</span><div><h3>Inventory alerts</h3><p>Each product can still use its own low-stock warning level from the Products page.</p></div></article><article className="panel settings-card"><span>⌁</span><div><h3>Trend accuracy</h3><p>Record every sale and expense on its actual date for more accurate charts.</p></div></article></aside></section>;
}

function EntryModal({ type, products, product, sale, expense, defaultLowStock, close, submit }: { type: "sale" | "editSale" | "receivablePayment" | "expense" | "editExpense" | "product" | "stock" | "edit"; products: Product[]; product: Product | null; sale: Sale | null; expense: Expense | null; defaultLowStock: number; close: () => void; submit: (kind: string, p: Record<string, FormDataEntryValue>) => Promise<void> }) {
  const labels = { sale: "Record a Sale", editSale: "Edit Sale", receivablePayment: "Record Customer Payment", expense: "Add an Expense", editExpense: "Edit Expense", product: "Add a Product", stock: "Update Inventory", edit: "Edit Product" };
  function onSubmit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); submit(type, Object.fromEntries(new FormData(e.currentTarget))); }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.currentTarget === e.target) close(); }}><div className="modal"><button className="close" onClick={close}>×</button><p className="eyebrow">NUAN BUSINESS MANAGER</p><h2>{labels[type]}</h2><p className="modal-copy">Fill in the details below. Totals will be computed automatically.</p><form onSubmit={onSubmit}>
    {type === "sale" && <><label>Date<input type="date" name="date" defaultValue={today()} required /></label><label>Product<select name="productId" required>{products.map(p => <option key={p.id} value={p.id}>{p.name} — {p.stock} in stock</option>)}</select></label><div className="form-row"><label>Quantity<input type="number" min="1" name="quantity" defaultValue="1" required /></label><label>Discount given to customer<input type="number" min="0" step="0.01" name="discount" defaultValue="0" required /></label></div><label>Actual cost per pack <small>Optional</small><input type="number" min="0" step="0.01" name="unitCost" placeholder="Leave blank to use the product's regular cost"/><small>Use this when your supplier gives you a discounted cost.</small></label><div className="form-row"><label>Payment<select name="payment"><option>Cash</option><option>GCash</option><option>Maya</option><option>Bank transfer</option><option>Credit</option></select></label><label>Channel<select name="channel"><option>Direct sale</option><option>Facebook</option><option>TikTok</option><option>Pop-up booth</option><option>Reseller</option></select></label></div><div className="credit-fields"><p>For Credit sales only</p><div className="form-row"><label>Customer name<input name="customerName" placeholder="Name of customer"/></label><label>Due date<input type="date" name="dueDate"/></label></div></div></>}
    {type === "editSale" && sale && <><input type="hidden" name="saleId" value={sale.id}/><input type="hidden" name="oldProductId" value={sale.productId}/><input type="hidden" name="oldQuantity" value={sale.quantity}/><label>Date<input type="date" name="date" defaultValue={sale.saleDate} required /></label><label>Product<select name="productId" defaultValue={sale.productId} required>{products.map(p => <option key={p.id} value={p.id}>{p.name} — {p.stock} in stock</option>)}</select></label><div className="form-row"><label>Quantity<input type="number" min="1" name="quantity" defaultValue={sale.quantity} required /></label><label>Discount given to customer<input type="number" min="0" step="0.01" name="discount" defaultValue={sale.discount} required /></label></div><label>Actual cost per pack<input type="number" min="0" step="0.01" name="unitCost" defaultValue={sale.unitCost} required/><small>This cost applies only to this transaction.</small></label><div className="form-row"><label>Payment<select name="payment" defaultValue={sale.payment}><option>Cash</option><option>GCash</option><option>Maya</option><option>Bank transfer</option><option>Credit</option></select></label><label>Channel<select name="channel" defaultValue={sale.channel}><option>Direct sale</option><option>Facebook</option><option>TikTok</option><option>Pop-up booth</option><option>Reseller</option></select></label></div><div className="credit-fields"><p>For Credit sales only</p><div className="form-row"><label>Customer name<input name="customerName" defaultValue={sale.customerName||""}/></label><label>Due date<input type="date" name="dueDate" defaultValue={sale.dueDate||""}/></label></div></div><div className="info-note">Inventory and profit will be recalculated automatically.</div></>}
    {type === "receivablePayment" && sale && <><input type="hidden" name="saleId" value={sale.id}/><div className="receivable-summary"><span>{sale.customerName}</span><b>Balance: {money.format(Math.max(0,sale.total-(sale.amountPaid||0)))}</b><small>{sale.productName} • Due {sale.dueDate}</small></div><label>Payment date<input type="date" name="paymentDate" defaultValue={today()} required/></label><div className="form-row"><label>Amount received<input type="number" min="0.01" max={Math.max(0,sale.total-(sale.amountPaid||0))} step="0.01" name="amount" required/></label><label>Payment method<select name="method"><option>Cash</option><option>GCash</option><option>Maya</option><option>Bank transfer</option></select></label></div></>}
    {type === "expense" && <><label>Date<input type="date" name="date" defaultValue={today()} required /></label><label>Category<select name="category"><option>Packaging</option><option>Delivery</option><option>Booth fee</option><option>Marketing</option><option>Transportation</option><option>Other</option></select></label><label>Description<input name="description" placeholder="e.g. Delivery fee for today’s orders" required /></label><div className="form-row"><label>Amount<input type="number" min="0.01" step="0.01" name="amount" required /></label><label>Payment<select name="payment"><option>Cash</option><option>GCash</option><option>Maya</option><option>Bank transfer</option></select></label></div></>}
    {type === "editExpense" && expense && <><input type="hidden" name="expenseId" value={expense.id}/><label>Date<input type="date" name="date" defaultValue={expense.expenseDate} required /></label><label>Category<select name="category" defaultValue={expense.category}><option>Packaging</option><option>Delivery</option><option>Booth fee</option><option>Marketing</option><option>Transportation</option><option>Other</option></select></label><label>Description<input name="description" defaultValue={expense.description} required /></label><div className="form-row"><label>Amount<input type="number" min="0.01" step="0.01" name="amount" defaultValue={expense.amount} required /></label><label>Payment<select name="payment" defaultValue={expense.payment}><option>Cash</option><option>GCash</option><option>Maya</option><option>Bank transfer</option></select></label></div></>}
    {type === "product" && <><label>Product name<input name="name" placeholder="e.g. Mango Pastillas" required /></label><label>Flavor<input name="flavor" placeholder="e.g. Mango" required /></label><div className="form-row"><label>Cost per pack<input type="number" min="0" step="0.01" name="cost" required /></label><label>Selling price<input type="number" min="0" step="0.01" name="price" required /></label></div><div className="form-row"><label>Opening stock<input type="number" min="0" name="stock" defaultValue="0" required /></label><label>Low-stock warning<input type="number" min="0" name="lowStock" defaultValue={defaultLowStock} required /></label></div></>}
    {type === "edit" && product && <><input type="hidden" name="productId" value={product.id} /><label>Product name<input name="name" defaultValue={product.name} required /></label><label>Flavor<input name="flavor" defaultValue={product.flavor} required /></label><div className="form-row"><label>Cost per pack<input type="number" min="0" step="0.01" name="cost" defaultValue={product.cost} required /><small>Future sales only</small></label><label>Selling price<input type="number" min="0" step="0.01" name="price" defaultValue={product.price} required /></label></div><label>Low-stock warning<input type="number" min="0" name="lowStock" defaultValue={product.lowStock} required /></label><div className="info-note">Existing sales keep their original cost and profit records.</div></>}
    {type === "stock" && <><label>Product<select name="productId" defaultValue={product?.id} required>{products.map(p => <option key={p.id} value={p.id}>{p.name} — currently {p.stock}</option>)}</select></label><div className="form-row"><label>Action<select name="adjustmentType"><option>Add</option><option>Deduct</option></select></label><label>Number of packs<input type="number" min="1" name="quantity" defaultValue="1" required /></label></div><label>Note <small>Optional</small><input name="note" placeholder="e.g. New supplier delivery or damaged pack" /></label><div className="info-note">Use Deduct for damaged, returned, or manually corrected stock. Recorded sales already deduct inventory automatically.</div></>}
    <button className="primary submit" type="submit">Save and Update Dashboard</button>
  </form></div></div>;
}
