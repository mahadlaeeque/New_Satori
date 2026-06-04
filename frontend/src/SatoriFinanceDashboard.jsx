import { useState, useMemo } from "react";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from "recharts";
import {
  Home, Eye, FileText, CreditCard, BookOpen, TrendingUp,
  ChevronDown, Calendar, Filter, ChevronLeft, ChevronRight,
  Users, DollarSign, Clock, CheckCircle, AlertTriangle, BarChart3
} from "lucide-react";

// ─── Color Palette ───
const C = {
  sidebarBg: "#1a2744",
  sidebarActive: "#2563eb",
  sidebarHover: "#1e3a5f",
  headerBg: "#f0f4f8",
  white: "#ffffff",
  cardBorder: "#e2e8f0",
  textDark: "#1e293b",
  textMid: "#475569",
  textLight: "#94a3b8",
  accent: "#2563eb",
  red: "#dc2626",
  green: "#16a34a",
  darkBar: "#1e3a5f",
  blueBar: "#2563eb",
  tealBar: "#0891b2",
  greenBar: "#16a34a",
  orangeBar: "#f59e0b",
  redBar: "#dc2626",
};

// ─── Sample Data ───
const kpiData = {
  totalReceivable: "-615.1M",
  overdueReceivable: "-616.5M",
  overduePercent: "100.2% w.r.t Total",
  futureReceivable: "1.3M",
  futurePercent: "-0.2% w.r.t Total",
  dso: "35.76",
  onTimeRate: "26.23%",
  onTimeChange: "0.0% from previous day",
  totalCustomers: "1,124",
};

const dsoTrendData = [
  { year: "2024 Q1", value: 52 },
  { year: "2024 Q2", value: 55 },
  { year: "2024 Q3", value: 50 },
  { year: "2025", value: 55 },
  { year: "2025 Q2", value: 45 },
  { year: "2025 Q3", value: 35 },
  { year: "2026", value: 18.58 },
];

const agingOverdueData = [
  { bucket: ">365", value: -600.00 },
  { bucket: "181-365", value: 1770 },
  { bucket: "91-180", value: 1200 },
  { bucket: "61-90", value: -1530 },
  { bucket: "31-60", value: -1590 },
  { bucket: "0-30", value: -465.36 },
];

const agingFutureData = [
  { bucket: "0-30", value: 1300000 },
];

const topCustomersData = [
  { id: "100574", name: "FFU", amount: 134992596 },
  { id: "100300", name: "ENGRO FERTILIZERS LTD#1 (FFU)", amount: 82039500 },
  { id: "100462", name: "ENGRO FERTILIZERS LTD (FFU)", amount: 73065600 },
  { id: "100247", name: "ENGRO FERTILIZERS LIMITED", amount: 49013425 },
  { id: "100568", name: "GOURMET BEVERAGE(FIVE STAR FOOD-FSD", amount: 42411164 },
  { id: "100581", name: "HAMZA WEAVING FACTORY - FOR ROTAT (", amount: 40190433 },
  { id: "100196", name: "JADEED FEEDS INDS (PVT) LTD(KNWL) (", amount: 39769485 },
];

const invoiceData = [
  { invoiceNo: "400004713", invoiceDate: "Dec 31, 2025", dueDate: "Oct 31, 2025", clearing: "-", customer: "ENGRO FERTILIZERS LIMITED", amount: 121832640 },
  { invoiceNo: "400004659", invoiceDate: "Dec 31, 2025", dueDate: "May 31, 2025", clearing: "-", customer: "FFU", amount: 113769247 },
  { invoiceNo: "400005330", invoiceDate: "Dec 31, 2025", dueDate: "Jun 30, 2025", clearing: "-", customer: "ENGRO FERTILIZERS LTD#1 (FFU)", amount: 82039500 },
  { invoiceNo: "400004915", invoiceDate: "Dec 31, 2025", dueDate: "Nov 30, 2025", clearing: "-", customer: "ENGRO FERTILIZERS LTD (FFU)", amount: 53524800 },
  { invoiceNo: "400004712", invoiceDate: "Dec 31, 2025", dueDate: "Nov 30, 2025", clearing: "-", customer: "ENGRO FERTILIZERS LIMITED", amount: 46940400 },
  { invoiceNo: "400005636", invoiceDate: "Dec 31, 2025", dueDate: "Nov 30, 2025", clearing: "-", customer: "SHEIKHOO SUGAR MILLS LIMITED.", amount: 41459595 },
];

// ─── Navigation Items ───
const navItems = [
  { icon: Home, label: "HOME", key: "home" },
  { icon: Eye, label: "OVERVIEW", key: "overview" },
  { icon: CreditCard, label: "ACCOUNTS PAYABLE", key: "ap" },
  { icon: FileText, label: "ACCOUNTS RECEIVABLE", key: "ar" },
  { icon: BookOpen, label: "BALANCESHEET", key: "bs" },
  { icon: TrendingUp, label: "PROFIT & LOSS", key: "pl" },
  { icon: FileText, label: "P&L Detail", key: "pld" },
  { icon: Users, label: "Customer/ Vendor Ledger", key: "cvl" },
];

// ─── Format Helpers ───
const formatAmount = (val) => {
  if (val === undefined || val === null) return "-";
  return val.toLocaleString("en-US");
};

const formatMillions = (val) => {
  const abs = Math.abs(val);
  if (abs >= 1000) return `${(val / 1000).toFixed(2)}B`;
  return `${val.toFixed(0)}M`;
};

// ─── Main Component ───
export default function SatoriFinanceDashboard() {
  const [activePage, setActivePage] = useState("ar");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [dateRange] = useState("Apr 8, 2026 - Apr 8, 2026");

  const filteredInvoices = useMemo(() => {
    if (!selectedCustomer) return invoiceData;
    return invoiceData.filter(inv => inv.customer.includes(selectedCustomer));
  }, [selectedCustomer]);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "'Segoe UI', -apple-system, sans-serif", background: "#f1f5f9", overflow: "hidden" }}>
      {/* ═══ Sidebar ═══ */}
      <aside style={{
        width: sidebarCollapsed ? 60 : 220,
        background: C.sidebarBg,
        display: "flex",
        flexDirection: "column",
        transition: "width 0.25s ease",
        flexShrink: 0,
        overflow: "hidden",
      }}>
        {/* Brand */}
        <div style={{
          padding: sidebarCollapsed ? "20px 10px" : "24px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          textAlign: sidebarCollapsed ? "center" : "left",
        }}>
          {!sidebarCollapsed && (
            <>
              <div style={{ color: "#fff", fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>satori</div>
              <div style={{ color: "#60a5fa", fontSize: 11, fontWeight: 500, letterSpacing: 0.5, marginTop: 2 }}>Finance Analysis</div>
            </>
          )}
          {sidebarCollapsed && (
            <div style={{ color: "#fff", fontSize: 18, fontWeight: 700 }}>S</div>
          )}
        </div>

        {/* Nav Items */}
        <nav style={{ flex: 1, padding: "8px 0", overflowY: "auto" }}>
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = activePage === item.key;
            return (
              <div
                key={item.key}
                onClick={() => setActivePage(item.key)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: sidebarCollapsed ? "12px 0" : "11px 20px",
                  justifyContent: sidebarCollapsed ? "center" : "flex-start",
                  cursor: "pointer",
                  background: isActive ? C.sidebarActive : "transparent",
                  borderLeft: isActive ? "3px solid #60a5fa" : "3px solid transparent",
                  color: isActive ? "#fff" : "rgba(255,255,255,0.6)",
                  fontSize: 12.5,
                  fontWeight: isActive ? 600 : 400,
                  letterSpacing: 0.3,
                  transition: "all 0.15s",
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = C.sidebarHover; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <Icon size={18} />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </div>
            );
          })}
        </nav>

        {/* Collapse Toggle */}
        <div
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          style={{
            padding: 12,
            textAlign: "center",
            cursor: "pointer",
            borderTop: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.5)",
          }}
        >
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </div>
      </aside>

      {/* ═══ Main Content ═══ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* ─── Header ─── */}
        <header style={{
          background: C.white,
          padding: "16px 28px 0",
          borderBottom: "1px solid #e2e8f0",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: C.textDark, margin: 0, letterSpacing: -0.5 }}>
              ACCOUNTS RECEIVABLE
            </h1>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: C.textLight }}>*All Amounts in Rs</span>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "#f8fafc", border: "1px solid #e2e8f0",
                borderRadius: 8, padding: "7px 14px", fontSize: 13, color: C.textMid,
              }}>
                <Calendar size={15} />
                {dateRange}
                <ChevronDown size={14} />
              </div>
            </div>
          </div>

          {/* Filters */}
          <div style={{ display: "flex", gap: 10, paddingBottom: 14, flexWrap: "wrap" }}>
            <FilterPill icon={Filter} label="Filters +" />
            <FilterPill label="Company Name" hasDropdown />
            <FilterPill label="Customer No." hasDropdown />
            <FilterPill label="Customer Name" hasDropdown />
            <FilterPill label="Profit Center No." hasDropdown />
            <FilterPill label="Profit Center Name" hasDropdown />
          </div>
        </header>

        {/* ─── Scrollable Dashboard Content ─── */}
        <main style={{ flex: 1, overflow: "auto", padding: "20px 28px 28px" }}>
          {/* KPI Row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 14, marginBottom: 20 }}>
            <KPICard
              label="Total Receivable Amount"
              value={kpiData.totalReceivable}
              icon={DollarSign}
              color={C.darkBar}
              links={["Drill", "Sort", "Explore"]}
            />
            <KPICard
              label="Overdue Receivable Amount"
              value={kpiData.overdueReceivable}
              sub={kpiData.overduePercent}
              subColor={C.red}
              icon={AlertTriangle}
              color={C.red}
              progressPercent={100}
              progressColor={C.red}
            />
            <KPICard
              label="Future Receivable Amount"
              value={kpiData.futureReceivable}
              sub={kpiData.futurePercent}
              subColor={C.green}
              icon={TrendingUp}
              color={C.green}
            />
            <KPICard
              label="Days Sales Outstanding"
              value={kpiData.dso}
              icon={Clock}
              color={C.accent}
            />
            <KPICard
              label="On Time Receivable Rate"
              value={kpiData.onTimeRate}
              sub={kpiData.onTimeChange}
              icon={CheckCircle}
              color={C.green}
            />
            <KPICard
              label="Total Customers"
              value={kpiData.totalCustomers}
              icon={Users}
              color={C.accent}
            />
          </div>

          {/* Charts Row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1fr", gap: 14, marginBottom: 20 }}>
            {/* DSO Trend */}
            <ChartPanel title="Day Sales Outstanding Trend">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={dsoTrendData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="year" tick={{ fontSize: 11, fill: C.textLight }} />
                  <YAxis tick={{ fontSize: 11, fill: C.textLight }} domain={[0, 70]} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Line
                    type="monotone" dataKey="value" stroke={C.darkBar}
                    strokeWidth={2.5} dot={{ r: 4, fill: C.darkBar }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>

            {/* Aging Bracket - Overdue */}
            <ChartPanel
              title="Aging Bracket By Overdue Receivables Amount"
              subtitle="Click any bucket to see details | Click again to reset"
            >
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={agingOverdueData}
                  layout="vertical"
                  margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: C.textLight }}
                    tickFormatter={(v) => {
                      if (v === 0) return "0";
                      return `${(v / 1000).toFixed(0)}B`;
                    }}
                  />
                  <YAxis dataKey="bucket" type="category" tick={{ fontSize: 11, fill: C.textMid }} width={55} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    formatter={(val) => [`${val.toLocaleString()}M`, "Amount"]}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={22}>
                    {agingOverdueData.map((entry, i) => (
                      <Cell key={i} fill={entry.value >= 0 ? C.tealBar : C.darkBar} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>

            {/* Aging Bracket - Future */}
            <ChartPanel title="Aging Bracket By Future Receivables Amount">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={agingFutureData}
                  layout="vertical"
                  margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: C.textLight }}
                    tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`}
                  />
                  <YAxis dataKey="bucket" type="category" tick={{ fontSize: 11, fill: C.textMid }} width={40} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(val) => [`${formatAmount(val)}`, "Amount"]} />
                  <Bar dataKey="value" fill={C.darkBar} radius={[0, 4, 4, 0]} barSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>

          {/* Tables Row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 14 }}>
            {/* Top 10 Customers */}
            <ChartPanel
              title="Top 10 Customers having Receivables"
              subtitle="Click any customer to see detailed invoices | Click again to reset"
            >
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: C.red, color: "#fff" }}>
                      <th style={thStyle}>Customer</th>
                      <th style={thStyle}>CustomerName</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Total Receivables Amount ▼</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topCustomersData.map((row, i) => (
                      <tr
                        key={row.id}
                        onClick={() => setSelectedCustomer(selectedCustomer === row.name ? null : row.name)}
                        style={{
                          background: selectedCustomer === row.name ? "#eff6ff" : i % 2 === 0 ? "#fff" : "#fafbfc",
                          cursor: "pointer",
                          transition: "background 0.15s",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = "#f0f7ff"}
                        onMouseLeave={e => e.currentTarget.style.background = selectedCustomer === row.name ? "#eff6ff" : i % 2 === 0 ? "#fff" : "#fafbfc"}
                      >
                        <td style={tdStyle}>{row.id}</td>
                        <td style={tdStyle}>{row.name}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: C.accent }}>
                          {formatAmount(row.amount)}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ background: "#f1f5f9", fontWeight: 700 }}>
                      <td style={tdStyle} colSpan={2}>Grand total</td>
                      <td style={{ ...tdStyle, textAlign: "right", color: C.red }}>
                        -615,125,245
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </ChartPanel>

            {/* Invoice Level Detail */}
            <ChartPanel title="Invoice level Detail">
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: C.red, color: "#fff" }}>
                      <th style={thStyle}>Invoice No.</th>
                      <th style={thStyle}>Invoice Date</th>
                      <th style={thStyle}>Due Date</th>
                      <th style={thStyle}>Clearing ...</th>
                      <th style={thStyle}>Customer</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Total Receivable Amount ▼</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInvoices.map((row, i) => (
                      <tr key={row.invoiceNo} style={{ background: i % 2 === 0 ? "#fff" : "#fafbfc" }}>
                        <td style={tdStyle}>{row.invoiceNo}</td>
                        <td style={tdStyle}>{row.invoiceDate}</td>
                        <td style={tdStyle}>{row.dueDate}</td>
                        <td style={tdStyle}>{row.clearing}</td>
                        <td style={tdStyle}>{row.customer}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: C.accent }}>
                          {formatAmount(row.amount)}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ background: "#f1f5f9", fontWeight: 700 }}>
                      <td style={tdStyle} colSpan={5}>Grand total</td>
                      <td style={{ ...tdStyle, textAlign: "right", color: C.red }}>
                        -615,125,244.99
                      </td>
                    </tr>
                  </tbody>
                </table>
                {/* Pagination */}
                <div style={{
                  display: "flex", justifyContent: "flex-end", alignItems: "center",
                  gap: 8, padding: "10px 0 0", fontSize: 12, color: C.textLight,
                }}>
                  <span>1 - 100 / 9415</span>
                  <button style={pageBtnStyle}><ChevronLeft size={14} /></button>
                  <button style={pageBtnStyle}><ChevronRight size={14} /></button>
                </div>
              </div>
            </ChartPanel>
          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Sub-Components ───

function FilterPill({ label, icon: Icon, hasDropdown }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      background: "#e8edf4", border: "1px solid #cbd5e1",
      borderRadius: 6, padding: "6px 14px", fontSize: 12.5,
      color: "#334155", cursor: "pointer", fontWeight: 500,
      transition: "all 0.15s",
    }}
      onMouseEnter={e => e.currentTarget.style.background = "#dde4ee"}
      onMouseLeave={e => e.currentTarget.style.background = "#e8edf4"}
    >
      {Icon && <Icon size={14} />}
      {label}
      {hasDropdown && <ChevronDown size={13} style={{ marginLeft: 2 }} />}
    </div>
  );
}

function KPICard({ label, value, sub, subColor, icon: Icon, color, links, progressPercent, progressColor }) {
  return (
    <div style={{
      background: C.white,
      borderRadius: 10,
      padding: "16px 18px",
      border: "1px solid #e2e8f0",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      display: "flex",
      flexDirection: "column",
      gap: 4,
      position: "relative",
      transition: "box-shadow 0.2s",
    }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"}
    >
      <div style={{ fontSize: 11.5, color: C.textLight, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: C.textDark, lineHeight: 1.2 }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 11, color: subColor || C.textLight, fontWeight: 500 }}>{sub}</div>
      )}
      {progressPercent !== undefined && (
        <div style={{ height: 5, background: "#fee2e2", borderRadius: 3, marginTop: 4, overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: `${Math.min(progressPercent, 100)}%`,
            background: progressColor || C.red,
            borderRadius: 3,
            transition: "width 0.5s",
          }} />
        </div>
      )}
      {links && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          {links.map(l => (
            <span key={l} style={{ fontSize: 11, color: C.accent, cursor: "pointer", textDecoration: "underline" }}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function ChartPanel({ title, subtitle, children }) {
  return (
    <div style={{
      background: C.white,
      borderRadius: 10,
      padding: "16px 18px",
      border: "1px solid #e2e8f0",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: C.textDark }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 10.5, color: "#f59e0b", marginTop: 2 }}>
            💡 {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Shared Styles ───
const thStyle = {
  padding: "8px 10px",
  textAlign: "left",
  fontWeight: 600,
  fontSize: 12,
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "7px 10px",
  borderBottom: "1px solid #f1f5f9",
  whiteSpace: "nowrap",
};

const pageBtnStyle = {
  background: "none",
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  padding: "3px 6px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  color: "#64748b",
};
