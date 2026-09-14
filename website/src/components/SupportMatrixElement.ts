import type { SupportMatrixData, SupportTarget, TargetCapability } from "../lib/support-matrix";

type View = "database" | "driver" | "capability";
type Locale = "en" | "ko";
interface Row { target: SupportTarget; capabilityId?: string; capability?: TargetCapability }
const ROW_HEIGHT = 56;
const labels = {
  en: { database: "Database", driver: "Driver", capability: "Capability", version: "Version", edition: "Edition", runtime: "Runtime", status: "Support status", search: "Search", all: "All", reset: "Reset", results: "results", condition: "Condition", test: "Test ID", ci: "CI gate", profile: "Profile", integer: "Driver raw integer", decimal: "Driver raw decimal", json: "Driver raw JSON", temporal: "Driver raw temporal", canonical: "SQLBraid canonical", policy: "TypePolicy", options: "Required options", transport: "Numeric transport", stream: "Streaming", routine: "Routines", bulk: "Bulk", exclusions: "Excluded profiles", target: "Target", transparency: "Native SQL transparency", generated: "Generated structure", exactNumeric: "Exact numeric", approximate: "Approximate float", returning: "Returned rows", metadata: "Metadata" },
  ko: { database: "데이터베이스", driver: "드라이버", capability: "기능", version: "버전", edition: "에디션", runtime: "런타임", status: "지원 상태", search: "검색", all: "전체", reset: "초기화", results: "개 결과", condition: "조건", test: "테스트 ID", ci: "CI 게이트", profile: "프로필", integer: "드라이버 원시 정수", decimal: "드라이버 원시 소수", json: "드라이버 원시 JSON", temporal: "드라이버 원시 시간", canonical: "SQLBraid 표준 표현", policy: "TypePolicy", options: "필수 옵션", transport: "숫자 전송", stream: "스트리밍", routine: "루틴", bulk: "벌크", exclusions: "제외 프로필", target: "대상", transparency: "네이티브 SQL 투명성", generated: "생성 구조", exactNumeric: "정확한 숫자", approximate: "근사 부동소수점", returning: "반환 행", metadata: "메타데이터" },
};
const states: Record<string, readonly [string, string]> = {
  official: ["Official", "공식"], conditional: ["Conditional", "조건부"], compatible: ["Compatible", "호환 가능"], historical: ["Historical", "과거 검증"], unsupported: ["Unsupported", "지원하지 않음"], guaranteed: ["Guaranteed", "보장됨"], guarded: ["Guarded", "값 검사"], pending: ["Pending", "검증 대기"],
};
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

class SupportMatrixElement extends HTMLElement {
  private data!: SupportMatrixData;
  private locale: Locale = "en";
  private view: View = "database";
  private rows: Row[] = [];
  private viewport!: HTMLElement;
  private layer!: HTMLElement;
  private search!: HTMLInputElement;
  private filters!: Record<string, HTMLSelectElement>;
  private frame = 0;
  private payloadObserver?: MutationObserver;
  private hashListener = () => this.followHash();

  connectedCallback(): void {
    if (this.classList.contains("is-ready")) return;
    const parent = this.parentElement;
    const script = parent?.querySelector<HTMLScriptElement>("script[data-support-matrix]");
    const payload = script?.textContent;
    if (!payload) {
      if (parent && !this.payloadObserver) {
        this.payloadObserver = new MutationObserver(() => {
          const next = parent.querySelector<HTMLScriptElement>("script[data-support-matrix]")?.textContent;
          if (!next) return;
          this.payloadObserver?.disconnect();
          this.payloadObserver = undefined;
          this.connectedCallback();
        });
        this.payloadObserver.observe(parent, { childList: true, subtree: true });
      }
      return;
    }
    this.data = JSON.parse(payload) as SupportMatrixData;
    this.locale = document.documentElement.lang.startsWith("ko") ? "ko" : "en";
    const l = labels[this.locale];
    this.innerHTML = `<div class="support-matrix__interactive">
      <div class="support-matrix__toolbar">
        <div role="tablist" aria-label="${l.capability}" class="support-matrix__views">${(["database", "driver", "capability"] as const).map((view) => `<button type="button" role="tab" data-view="${view}" id="matrix-${this.locale}-${view}" aria-controls="matrix-${this.locale}-panel">${l[view]}</button>`).join("")}</div>
        <label>${l.search}<input type="search" data-search /></label>
        <div class="support-matrix__filters">${(["database", "driver", "runtime", "status", "profile", "capability"] as const).map((key) => `<label>${l[key]}<select data-filter="${key}"><option value="">${l.all}</option></select></label>`).join("")}</div>
        <button type="button" data-reset>${l.reset}</button><output data-count aria-live="polite"></output>
      </div>
      <div role="tabpanel" id="matrix-${this.locale}-panel" data-panel>
        <div class="support-matrix__viewport" data-viewport role="table" tabindex="0" aria-label="${l.target}">
          <div class="support-matrix__header-slot" data-header></div><div class="support-matrix__rows" data-rows></div>
        </div>
      </div>
    </div>`;
    this.viewport = this.querySelector<HTMLElement>("[data-viewport]")!;
    this.layer = this.querySelector<HTMLElement>("[data-rows]")!;
    this.search = this.querySelector<HTMLInputElement>("[data-search]")!;
    this.filters = Object.fromEntries([...this.querySelectorAll<HTMLSelectElement>("[data-filter]")].map((select) => [select.dataset.filter!, select]));
    for (const [key, select] of Object.entries(this.filters)) {
      const values = key === "capability" ? this.data.capabilities.map((c) => c.id) : [...new Set(this.data.targets.map((t) => key === "status" ? t.status : key === "database" ? t.database.product : key === "driver" ? t.driver.id : key === "profile" ? t.driver.profile : t.runtime.id).filter((value): value is string => Boolean(value)))];
      for (const value of values.sort()) select.add(new Option(key === "capability" ? this.capabilityLabel(value) : key === "status" ? this.status(value) : value, value));
    }
    this.addEventListener("input", (event) => { if (event.target === this.search) this.rebuild(); });
    this.addEventListener("change", () => this.rebuild());
    this.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const view = target.closest<HTMLButtonElement>("[data-view]")?.dataset.view;
      if (view === "database" || view === "driver" || view === "capability") { this.view = view; this.rebuild(); }
      if (target.closest("[data-reset]")) { this.search.value = ""; Object.values(this.filters).forEach((s) => { s.value = ""; }); this.rebuild(); }
      const link = target.closest<HTMLAnchorElement>("[data-target-link]");
      if (link) { event.preventDefault(); history.replaceState(null, "", link.hash); this.followHash(); }
    });
    this.addEventListener("keydown", (event) => this.keydown(event));
    this.viewport.addEventListener("scroll", () => {
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderVisible(); });
    });
    this.parentElement?.classList.add("has-js");
    this.classList.add("is-ready");
    this.rebuild();
    window.addEventListener("hashchange", this.hashListener);
    this.followHash();
  }

  disconnectedCallback(): void {
    this.payloadObserver?.disconnect();
    this.payloadObserver = undefined;
    window.removeEventListener("hashchange", this.hashListener);
    cancelAnimationFrame(this.frame);
  }

  private status(value: string): string { return states[value]?.[this.locale === "ko" ? 1 : 0] ?? value; }
  private capabilityLabel(id: string): string { return this.data.capabilities.find((c) => c.id === id)?.labels[this.locale] ?? id; }
  private condition(code?: string): string { return code ? this.data.conditions.find((c) => c.code === code)?.labels[this.locale] ?? code : "—"; }
  private capabilities(target: SupportTarget, prefix: string): string {
    const entries = Object.entries(target.capabilities).filter(([id]) => id === prefix || id.startsWith(`${prefix}.`));
    return entries.map(([id, cap]) => `${entries.length > 1 ? `${this.capabilityLabel(id)}: ` : ""}${this.status(cap.status)}${cap.conditionCode ? ` (${this.condition(cap.conditionCode)})` : ""}`).join("; ") || "—";
  }

  private numeric(target: SupportTarget, kind: keyof SupportTarget["numeric"]): string {
    const contract = target.numeric[kind];
    if (!contract) return "—";
    const precision = contract.binaryPrecision === undefined ? "" : `/${contract.binaryPrecision}`;
    return `${contract.representation} · ${contract.fidelity}${precision}${contract.profile ? ` · ${contract.profile}` : ""}`;
  }

  private rebuild(): void {
    const f = this.filters;
    const search = this.search.value.trim().toLocaleLowerCase(this.locale);
    const targets = this.data.targets.filter((t) => (!f.database.value || t.database.product === f.database.value) && (!f.driver.value || t.driver.id === f.driver.value) && (!f.runtime.value || t.runtime.id === f.runtime.value) && (!f.status.value || t.status === f.status.value) && (!f.profile.value || t.driver.profile === f.profile.value) && (!f.capability.value || Object.hasOwn(t.capabilities, f.capability.value)));
    this.rows = targets.flatMap((target): Row[] => this.view === "capability" ? Object.entries(target.capabilities).filter(([id]) => !f.capability.value || id === f.capability.value).map(([capabilityId, capability]) => ({ target, capabilityId, capability })) : [{ target }]).filter((row) => !search || JSON.stringify([row.target.id, row.target.database, row.target.driver, row.target.runtime, row.target.status, row.capabilityId ? this.capabilityLabel(row.capabilityId) : "", row.capability]).toLocaleLowerCase(this.locale).includes(search));
    const columns = this.columns();
    this.style.setProperty("--matrix-columns", String(columns.length));
    this.querySelector("[data-panel]")!.setAttribute("aria-labelledby", `matrix-${this.locale}-${this.view}`);
    this.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => { const selected = button.dataset.view === this.view; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; });
    this.querySelector("[data-header]")!.innerHTML = `<div class="support-matrix__row support-matrix__header" role="row" aria-rowindex="1">${columns.map((c) => `<span role="columnheader">${escape(c)}</span>`).join("")}</div>`;
    this.viewport.setAttribute("aria-rowcount", String(this.rows.length + 1));
    this.viewport.setAttribute("aria-colcount", String(columns.length));
    this.layer.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    this.viewport.scrollTop = 0;
    this.querySelector("[data-count]")!.textContent = `${this.rows.length} ${labels[this.locale].results}`;
    this.renderVisible();
  }

  private columns(): string[] {
    const l = labels[this.locale];
    return this.view === "database" ? [l.target, l.database, l.version, l.edition, l.driver, l.runtime, l.status, l.transparency, l.generated, l.exactNumeric, l.approximate, l.transport, l.json, l.temporal, l.returning, l.stream, l.routine, l.bulk, l.metadata] : this.view === "driver" ? [l.driver, l.version, l.target, l.runtime, l.profile, l.integer, l.decimal, l.json, l.temporal, l.canonical, l.policy, l.options, l.stream, l.routine, l.bulk, l.exclusions] : [l.capability, l.target, l.status, l.condition, l.test, l.ci];
  }

  private cells(row: Row): string[] {
    const t = row.target;
    if (this.view === "capability") return [this.capabilityLabel(row.capabilityId!), t.id, this.status(row.capability!.status), this.condition(row.capability!.conditionCode), row.capability!.testIds?.join(", ") ?? "—", [t.ci?.command, t.ci?.workflow].filter(Boolean).join(" · ")];
    if (this.view === "driver") {
      const driver = t.driver as SupportTarget["driver"] & { driverRawRepresentations?: Readonly<Record<string, string>>; sqlbraidRepresentations?: Readonly<Record<string, string>>; requiredOptions?: unknown };
      const raw = driver.driverRawRepresentations ?? {};
      const canonical = driver.sqlbraidRepresentations ?? {};
      const policy = (t as SupportTarget & { typePolicy?: { id: string; hash: string } }).typePolicy;
      return [t.driver.id, t.driver.version ?? "—", t.id, `${t.runtime.id} ${t.runtime.version ?? ""}`, t.driver.profile ?? "—", raw.integer ?? "—", raw.decimal ?? "—", raw.json ?? "—", raw.temporal ?? "—", [canonical.integer, canonical.decimal, canonical.json, canonical.temporal].filter(Boolean).join(" · ") || "—", policy ? `${policy.id}@${policy.hash}` : "—", driver.requiredOptions ? JSON.stringify(driver.requiredOptions) : "—", t.driver.stream ?? "—", t.driver.routine ?? "—", t.driver.bulk ?? "—", t.driver.exclusions?.join(", ") ?? "—"];
    }
    return [t.id, t.database.product, t.database.version ?? "—", t.database.edition ?? "—", `${t.driver.id} ${t.driver.version ?? ""}`, `${t.runtime.id} ${t.runtime.version ?? ""}`, this.status(t.status), this.capabilities(t, "sql.native-transparency"), this.capabilities(t, "sql.generated-structure"), [this.numeric(t, "exact-integer"), this.numeric(t, "exact-decimal")].join(" / "), this.numeric(t, "approximate-binary"), [this.numeric(t, "exact-integer"), this.numeric(t, "exact-decimal")].join(" / "), [this.capabilities(t, "data.json-parsed"), this.capabilities(t, "data.json-lossless-text")].filter((value) => value !== "—").join(" / ") || "—", [this.capabilities(t, "data.temporal-native"), this.capabilities(t, "data.temporal-lossless")].filter((value) => value !== "—").join(" / ") || "—", this.capabilities(t, "dml"), this.capabilities(t, "execution.stream"), this.capabilities(t, "routine"), this.capabilities(t, "execution.bulk"), this.capabilities(t, "metadata")];
  }

  private renderVisible(): void {
    const active = document.activeElement?.closest<HTMLElement>("[data-index]");
    const focused = active && this.layer.contains(active) ? Number(active.dataset.index) : undefined;
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - 4);
    const end = Math.min(this.rows.length, Math.ceil((this.viewport.scrollTop + (this.viewport.clientHeight || 560)) / ROW_HEIGHT) + 4);
    this.layer.innerHTML = this.rows.slice(start, end).map((row, offset) => {
      const index = start + offset;
      return `<div role="row" aria-rowindex="${index + 2}" class="support-matrix__row support-matrix__data-row" tabindex="0" data-index="${index}" style="top:${index * ROW_HEIGHT}px">${this.cells(row).map((cell) => `<span role="cell" title="${escape(cell)}">${cell === row.target.id ? `<a data-target-link href="#${encodeURIComponent(row.target.id)}">${escape(cell)}</a>` : escape(cell)}</span>`).join("")}</div>`;
    }).join("");
    if (focused !== undefined) this.layer.querySelector<HTMLElement>(`[data-index="${focused}"]`)?.focus({ preventScroll: true });
  }

  private focusRow(index: number): void {
    if (index < 0 || index >= this.rows.length) return;
    this.viewport.scrollTop = index * ROW_HEIGHT;
    this.renderVisible();
    this.layer.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true });
  }

  private followHash(): void {
    let id: string;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const index = this.rows.findIndex((r) => r.target.id === id);
    if (index >= 0) this.focusRow(index);
  }

  private keydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>("[data-view]");
    if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const views: View[] = ["database", "driver", "capability"];
      const index = views.indexOf(this.view);
      this.view = views[event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3]!;
      this.rebuild();
      this.querySelector<HTMLElement>(`[data-view="${this.view}"]`)?.focus();
      return;
    }
    const row = target.closest<HTMLElement>("[data-index]");
    if (!row || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = Number(row.dataset.index);
    this.focusRow(event.key === "Home" ? 0 : event.key === "End" ? this.rows.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1));
  }
}
if (!customElements.get("support-matrix")) customElements.define("support-matrix", SupportMatrixElement);
