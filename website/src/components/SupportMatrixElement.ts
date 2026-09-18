import {
  projectSupportMatrixRow,
  supportMatrixCapabilityLabel,
  supportMatrixColumns,
  supportMatrixStatus,
  type SupportMatrixData,
  type SupportMatrixLocale,
  type SupportMatrixRow,
  type SupportMatrixView,
} from "../lib/support-matrix";

type FilterKey = "database" | "driver" | "runtime" | "status" | "profile" | "capability";
const ROW_HEIGHT = 56;
const views: readonly SupportMatrixView[] = ["database", "driver", "capability"];
const labels = {
  en: {
    database: "Database",
    driver: "Driver",
    capability: "Capability",
    version: "Version",
    runtime: "Runtime",
    status: "Support status",
    search: "Search",
    all: "All",
    reset: "Reset",
    results: "results",
    profile: "Profile",
    target: "Target",
  },
  ko: {
    database: "데이터베이스",
    driver: "드라이버",
    capability: "기능",
    version: "버전",
    runtime: "런타임",
    status: "지원 상태",
    search: "검색",
    all: "전체",
    reset: "초기화",
    results: "개 결과",
    profile: "프로필",
    target: "대상",
  },
} as const;
const filterKeys: readonly FilterKey[] = ["database", "driver", "runtime", "status", "profile", "capability"];
const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

class SupportMatrixElement extends HTMLElement {
  private data!: SupportMatrixData;
  private locale: SupportMatrixLocale = "en";
  private view: SupportMatrixView = "database";
  private rows: SupportMatrixRow[] = [];
  private viewport!: HTMLElement;
  private layer!: HTMLElement;
  private search!: HTMLInputElement;
  private filters!: Record<FilterKey, HTMLSelectElement>;
  private frame = 0;
  private payloadObserver?: MutationObserver;
  private hashListener = () => this.followHash();

  connectedCallback(): void {
    if (this.classList.contains("is-ready")) {
      window.addEventListener("hashchange", this.hashListener);
      return;
    }
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
        <div role="tablist" aria-orientation="horizontal" aria-label="${l.capability}" class="support-matrix__views">${views.map((view) => `<button type="button" role="tab" data-view="${view}" id="matrix-${this.locale}-${view}" aria-controls="matrix-${this.locale}-panel">${l[view]}</button>`).join("")}</div>
        <label class="support-matrix__search">${l.search}<input type="search" data-search autocomplete="off" /></label>
        <div class="support-matrix__filters">${filterKeys.map((key) => `<label>${l[key]}<select data-filter="${key}"><option value="">${l.all}</option></select></label>`).join("")}<button class="support-matrix__reset" type="button" data-reset>${l.reset}</button></div>
        <output class="support-matrix__count" data-count aria-live="polite"></output>
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
    this.filters = Object.fromEntries(
      [...this.querySelectorAll<HTMLSelectElement>("[data-filter]")].map((select) => [select.dataset.filter!, select]),
    ) as Record<FilterKey, HTMLSelectElement>;
    for (const key of filterKeys) {
      if (key === "status") continue;
      const select = this.filters[key];
      const values =
        key === "capability"
          ? this.data.capabilities.map((capability) => capability.id)
          : [
              ...new Set(
                this.data.targets
                  .map((target) =>
                    key === "database"
                      ? target.database.product
                      : key === "driver"
                        ? target.driver.id
                        : key === "profile"
                          ? target.driver.profile
                          : target.runtime.id,
                  )
                  .filter((value): value is string => Boolean(value)),
              ),
            ];
      // eslint-disable-next-line unicorn/no-array-sort -- Both branches create an owned array for these options.
      for (const value of values.sort()) {
        const label = key === "capability" ? supportMatrixCapabilityLabel(this.data, value, this.locale) : value;
        select.add(new Option(label, value));
      }
    }
    this.refreshStatusFilter();
    this.addEventListener("input", (event) => {
      if (event.target === this.search) this.rebuild();
    });
    this.addEventListener("change", () => this.rebuild());
    this.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const selectedView = target.closest<HTMLButtonElement>("[data-view]")?.dataset.view;
      if (views.includes(selectedView as SupportMatrixView)) {
        this.view = selectedView as SupportMatrixView;
        this.refreshStatusFilter();
        this.rebuild();
      }
      if (target.closest("[data-reset]")) {
        this.search.value = "";
        Object.values(this.filters).forEach((select) => {
          select.value = "";
        });
        this.rebuild();
      }
      const link = target.closest<HTMLAnchorElement>("[data-target-link]");
      if (link) {
        event.preventDefault();
        history.replaceState(null, "", link.hash);
        this.followHash();
      }
    });
    this.addEventListener("keydown", (event) => this.keydown(event));
    this.viewport.addEventListener("scroll", () => {
      this.updateScrollEdges();
      if (!this.frame)
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.renderVisible();
        });
    });
    parent?.classList.add("has-js");
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

  private refreshStatusFilter(): void {
    const select = this.filters.status;
    const selected = select.value;
    const values =
      this.view === "capability"
        ? [
            ...new Set(
              this.data.targets.flatMap((target) =>
                Object.values(target.capabilities).map((capability) => capability.status),
              ),
            ),
          ]
        : [...new Set(this.data.targets.map((target) => target.status))];
    const allowed = new Set(values);
    while (select.options.length > 1) select.remove(1);
    // eslint-disable-next-line unicorn/no-array-sort -- This temporary option list is not shared with the support data.
    for (const value of values.sort()) select.add(new Option(supportMatrixStatus(value, this.locale), value));
    select.value = allowed.has(selected) ? selected : "";
  }

  private rebuild(): void {
    const f = this.filters;
    const search = this.search.value.trim().toLocaleLowerCase(this.locale);
    const targets = this.data.targets.filter(
      (target) =>
        (!f.database.value || target.database.product === f.database.value) &&
        (!f.driver.value || target.driver.id === f.driver.value) &&
        (!f.runtime.value || target.runtime.id === f.runtime.value) &&
        (this.view === "capability" || !f.status.value || target.status === f.status.value) &&
        (!f.profile.value || target.driver.profile === f.profile.value) &&
        (!f.capability.value || Object.hasOwn(target.capabilities, f.capability.value)),
    );
    this.rows = targets
      .flatMap((target): SupportMatrixRow[] =>
        this.view === "capability"
          ? Object.entries(target.capabilities)
              .filter(
                ([id, capability]) =>
                  (!f.capability.value || id === f.capability.value) &&
                  (!f.status.value || capability.status === f.status.value),
              )
              .map(([capabilityId, capability]) => ({ target, capabilityId, capability }))
          : [{ target }],
      )
      .filter(
        (row) =>
          !search ||
          JSON.stringify([
            row.target.id,
            row.target.database,
            row.target.driver,
            row.target.runtime,
            row.target.status,
            row.capabilityId ?? "",
            row.capability,
          ])
            .toLocaleLowerCase(this.locale)
            .includes(search),
      );
    const columns = supportMatrixColumns(this.view, this.locale);
    this.style.setProperty("--matrix-columns", String(columns.length));
    this.querySelector("[data-panel]")!.setAttribute("aria-labelledby", `matrix-${this.locale}-${this.view}`);
    this.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
      const selected = button.dataset.view === this.view;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    this.querySelector("[data-header]")!.innerHTML =
      `<div class="support-matrix__row support-matrix__header" role="row" aria-rowindex="1">${columns.map((column) => `<span role="columnheader">${escape(column)}</span>`).join("")}</div>`;
    this.viewport.setAttribute("aria-rowcount", String(this.rows.length + 1));
    this.viewport.setAttribute("aria-colcount", String(columns.length));
    this.layer.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    this.viewport.scrollTop = 0;
    this.querySelector("[data-count]")!.textContent = `${this.rows.length} ${labels[this.locale].results}`;
    this.renderVisible();
    this.updateScrollEdges();
  }

  private renderCell(value: string, index: number, row: SupportMatrixRow): string {
    const targetIndex = this.view === "database" ? 0 : this.view === "driver" ? 2 : 1;
    const statusIndex = this.view === "database" ? 4 : this.view === "capability" ? 2 : -1;
    const content =
      index === targetIndex
        ? `<a data-target-link href="#${encodeURIComponent(row.target.id)}">${escape(value)}</a>`
        : escape(value);
    if (index !== statusIndex) return content;
    const status = (this.view === "capability" ? row.capability?.status : row.target.status) ?? "unknown";
    const className = status.toLowerCase().replace(/[^a-z0-9-]/gu, "-");
    return `<span class="support-matrix__status support-matrix__status--${className}" data-status="${escape(status)}">${content}</span>`;
  }

  private renderVisible(): void {
    const active = document.activeElement?.closest<HTMLElement>("[data-index]");
    const focused = active && this.layer.contains(active) ? Number(active.dataset.index) : undefined;
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - 4);
    const end = Math.min(
      this.rows.length,
      Math.ceil((this.viewport.scrollTop + (this.viewport.clientHeight || 560)) / ROW_HEIGHT) + 4,
    );
    this.layer.innerHTML = this.rows
      .slice(start, end)
      .map((row, offset) => {
        const index = start + offset;
        const cells = projectSupportMatrixRow(this.data, this.view, row, this.locale);
        return `<div role="row" aria-rowindex="${index + 2}" class="support-matrix__row support-matrix__data-row" data-row-view="${this.view}" tabindex="0" data-index="${index}" style="top:${index * ROW_HEIGHT}px">${cells.map((cell, cellIndex) => `<span role="cell" title="${escape(cell)}">${this.renderCell(cell, cellIndex, row)}</span>`).join("")}</div>`;
      })
      .join("");
    if (focused !== undefined)
      this.layer.querySelector<HTMLElement>(`[data-index="${focused}"]`)?.focus({ preventScroll: true });
  }

  private updateScrollEdges(): void {
    if (!this.viewport) return;
    this.viewport.toggleAttribute("data-scroll-left", this.viewport.scrollLeft > 1);
    this.viewport.toggleAttribute(
      "data-scroll-right",
      this.viewport.scrollLeft + this.viewport.clientWidth < this.viewport.scrollWidth - 1,
    );
  }

  private focusRow(index: number): void {
    if (index < 0 || index >= this.rows.length) return;
    this.viewport.scrollTop = index * ROW_HEIGHT;
    this.renderVisible();
    this.layer.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true });
  }

  private followHash(): void {
    let id: string;
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      return;
    }
    const index = this.rows.findIndex((row) => row.target.id === id);
    if (index >= 0) this.focusRow(index);
  }

  private keydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>("[data-view]");
    if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = views.indexOf(this.view);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? views.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length;
      this.view = views[next]!;
      this.refreshStatusFilter();
      this.rebuild();
      this.querySelector<HTMLElement>(`[data-view="${this.view}"]`)?.focus();
      return;
    }
    const row = target.closest<HTMLElement>("[data-index]");
    if (!row || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = Number(row.dataset.index);
    this.focusRow(
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? this.rows.length - 1
          : index + (event.key === "ArrowDown" ? 1 : -1),
    );
  }
}
if (!customElements.get("support-matrix")) customElements.define("support-matrix", SupportMatrixElement);
