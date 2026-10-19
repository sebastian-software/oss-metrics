import "./styles.css";
import {
  ENDPOINT, ORG, SOURCE_NAMES, compact, filterProjects, integer, packageUrl, parseSnapshot,
  relativeDate, repoUrl, usageLabel,
  type Package, type Project, type ProjectFilter, type ProjectSort, type Snapshot, type Source,
} from "./model.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function link(text: string, href: string, className = "") {
  const result = node("a", className, text);
  result.href = href;
  return result;
}
function number(value: number) {
  const result = node("span", "number", compact(value));
  result.title = integer(value);
  return result;
}
function time(timestamp: string) {
  const result = node("time", "relative-time", relativeDate(timestamp));
  result.dateTime = timestamp;
  result.title = new Date(timestamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
  return result;
}
function cell(className = "", text?: string) { return node("td", className, text); }
const projectSearch = element<HTMLInputElement>("project-search");
const projectFilter = element<HTMLSelectElement>("project-filter");
const projectSort = element<HTMLSelectElement>("project-sort");
const packageSearch = element<HTMLInputElement>("package-search");
const packageRegistry = element<HTMLSelectElement>("package-registry");
const refresh = element<HTMLButtonElement>("refresh");
const previous = element<HTMLButtonElement>("package-prev");
const next = element<HTMLButtonElement>("package-next");
let snapshot: Snapshot | undefined;
let packagePage = 0;
const PAGE_SIZE = 12;

function renderSources(failed = false) {
  element("source-list").replaceChildren(...(Object.keys(SOURCE_NAMES) as Source[]).map((source) => {
    const status = snapshot?.sources[source] ?? (failed ? "error" : undefined);
    const row = node("li", `source-row ${status ?? "pending"}`);
    const name = node("span", "source-name");
    name.append(node("span", "source-dot"), document.createTextNode(SOURCE_NAMES[source]));
    const label = status === "ok" ? "Connected" : status === "error" ? "Unavailable"
      : status === "skipped" ? "Not connected" : "Waiting";
    row.append(name, node("span", "source-status", label));
    return row;
  }));
}

function downloads(project: Project) {
  const result = node("div", "download-values");
  for (const registry of ["npm", "crates"] as const) {
    const packages = project.packages.filter((pkg) => pkg.registry === registry);
    if (packages.length === 0) continue;
    const line = node("div");
    line.append(number(packages.reduce((total, pkg) => total + pkg.downloads, 0)),
      node("span", "unit", registry === "npm" ? " / mo · npm" : " total · crates"));
    result.append(line);
  }
  if (!result.childNodes.length) result.append(node("span", "muted", "—"));
  return result;
}

function projectDetails(project: Project) {
  const details = node("details", "project-details");
  details.append(node("summary", "", project.packages.length ? `${project.packages.length} package${project.packages.length === 1 ? "" : "s"}` : "More metrics"));
  const content = node("div", "project-detail-content");
  const facts = node("dl", "project-facts");
  facts.append(node("dt", "", "Forks"), node("dd", "", integer(project.forks)), node("dt", "", "Last push"));
  const pushed = node("dd"); pushed.append(time(project.pushedAt)); facts.append(pushed);
  if (project.release) {
    facts.append(node("dt", "", "GitHub release"));
    const release = node("dd");
    release.append(link(project.release.version, `${repoUrl(project.name)}/releases/tag/${encodeURIComponent(project.release.tag)}`));
    facts.append(release);
  }
  const usage = snapshot?.usage.get(project.name);
  if (usage) {
    const label = usageLabel(usage);
    facts.append(node("dt", "", "Active users*"), node("dd", "", label.text));
  }
  content.append(facts);
  if (project.packages.length) {
    const list = node("ul", "project-package-list");
    for (const pkg of project.packages) {
      const row = node("li");
      row.append(link(pkg.name, packageUrl(pkg)), node("span", "package-detail-version", `v${pkg.version}`),
        node("span", "muted", `${integer(pkg.downloads)} ${pkg.registry === "npm" ? "monthly downloads" : "all-time downloads"}`));
      if (pkg.recentDownloads !== undefined) row.append(node("span", "muted", `${integer(pkg.recentDownloads)} recent downloads`));
      list.append(row);
    }
    content.append(list);
  } else {
    content.append(node("p", "muted", snapshot?.sources.npm === "ok" && snapshot.sources.crates === "ok"
      ? "No linked registry packages." : "Registry data is unavailable or not configured."));
  }
  details.append(content);
  return details;
}

function version(project: Project) {
  const result = node("div", "version-value");
  if (project.release) {
    result.append(link(`v${project.release.version}`, `${repoUrl(project.name)}/releases/tag/${encodeURIComponent(project.release.tag)}`),
      node("span", "muted", "GitHub release"));
  } else {
    const pkg = [...project.packages].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
    if (pkg) result.append(link(`v${pkg.version}`, packageUrl(pkg)), node("span", "muted", pkg.registry === "npm" ? "npm package" : "crates.io package"));
    else result.append(node("span", "muted", snapshot?.sources.releases === "ok" ? "No release" : "Unavailable"));
  }
  return result;
}

function renderProjects() {
  if (!snapshot) return;
  const projects = filterProjects(snapshot.projects, projectSearch.value, projectFilter.value as ProjectFilter, projectSort.value as ProjectSort);
  element("project-total").textContent = snapshot.sources.github === "ok" ? integer(snapshot.projects.length) : "—";
  element("project-results").textContent = snapshot.sources.github === "ok"
    ? `${integer(projects.length)} of ${integer(snapshot.projects.length)} projects` : "GitHub data is unavailable";
  const hasUsage = snapshot.usage.size > 0;
  document.querySelectorAll<HTMLElement>(".usage-column").forEach((column) => { column.hidden = !hasUsage; });
  for (const id of ["project-name-heading", "stars-heading", "push-heading"]) element(id).removeAttribute("aria-sort");
  element(projectSort.value === "stars" ? "stars-heading" : projectSort.value === "activity" ? "push-heading" : "project-name-heading")
    .setAttribute("aria-sort", projectSort.value === "name" ? "ascending" : "descending");
  element("project-rows").replaceChildren(...projects.map((project) => {
    const row = node("tr");
    const name = cell("project-name");
    const title = node("div", "project-title");
    title.append(link(project.name, repoUrl(project.name)));
    const registries = [...new Set(project.packages.map((pkg) => pkg.registry))];
    for (const registry of registries) title.append(node("span", `registry-tag ${registry}`, registry === "crates" ? "Rust" : "npm"));
    name.append(title, projectDetails(project));
    const latest = cell("col-release"); latest.append(version(project));
    const stars = cell("numeric stars-value"); stars.append(number(project.stars));
    const counts = cell("numeric col-downloads"); counts.append(downloads(project));
    const activity = cell("numeric usage-column"); activity.hidden = !hasUsage;
    const label = usageLabel(snapshot!.usage.get(project.name));
    activity.textContent = label.text; activity.title = label.note;
    if (!/^\d/u.test(label.text)) activity.classList.add("muted");
    const pushed = cell("col-push"); pushed.append(time(project.pushedAt));
    row.append(name, latest, stars, counts, activity, pushed);
    return row;
  }));
  const empty = element("projects-empty");
  empty.hidden = projects.length > 0;
  empty.replaceChildren(node("p", "", snapshot.sources.github !== "ok" ? "Project data is unavailable. Check the sources and try refreshing."
    : snapshot.projects.length === 0 ? "No public projects are listed in this snapshot." : "No matching projects. Try another search or registry."));
}

function renderPackages() {
  if (!snapshot) return;
  const registry = packageRegistry.value === "crates" ? "crates" : "npm";
  const search = packageSearch.value.trim().toLocaleLowerCase("en-US");
  const packages = snapshot.packages.filter((pkg) => pkg.registry === registry &&
    (!search || [pkg.name, pkg.repo ?? ""].some((name) => name.toLocaleLowerCase("en-US").includes(search))))
    .sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name, "en"));
  const pages = Math.max(1, Math.ceil(packages.length / PAGE_SIZE));
  packagePage = Math.min(packagePage, pages - 1);
  const start = packagePage * PAGE_SIZE;
  element("package-total").textContent = snapshot.sources.npm === "ok" && snapshot.sources.crates === "ok" ? integer(snapshot.packages.length) : "—";
  element("package-downloads-heading").textContent = registry === "npm" ? "Monthly downloads" : "All-time downloads";
  element("package-results").textContent = snapshot.sources[registry] === "ok"
    ? `${integer(packages.length)} ${registry === "npm" ? "npm packages" : "crates"}${search ? " match your search" : ""}`
    : `${registry === "npm" ? "npm" : "crates.io"} data is unavailable`;
  element("package-rows").replaceChildren(...packages.slice(start, start + PAGE_SIZE).map((pkg) => {
    const row = node("tr");
    const name = cell("package-name");
    name.append(link(pkg.name, packageUrl(pkg)), node("span", "mobile-package-version", `v${pkg.version}`));
    if (pkg.repo) name.append(link(pkg.repo, repoUrl(pkg.repo), "package-repo"));
    const version = cell("package-version", `v${pkg.version}`);
    const downloads = cell("numeric"); downloads.append(number(pkg.downloads));
    const published = cell("package-published"); published.append(time(pkg.publishedAt));
    row.append(name, version, downloads, published);
    return row;
  }));
  element("packages-empty").hidden = packages.length > 0;
  element("packages-empty").replaceChildren(node("p", "", snapshot.sources[registry] !== "ok" ? "This registry is unavailable. Other data sources may still be connected."
    : "No matching packages. Try another search or registry."));
  element("package-page").textContent = packages.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, packages.length)} of ${integer(packages.length)}` : "0 packages";
  previous.disabled = packagePage === 0;
  next.disabled = packagePage >= pages - 1;
}

function render() {
  if (!snapshot) return;
  for (const [id, source, value] of [
    ["total-projects", "github", snapshot.projects.length],
    ["total-stars", "github", snapshot.projects.reduce((sum, project) => sum + project.stars, 0)],
    ["total-npm", "npm", snapshot.packages.filter((pkg) => pkg.registry === "npm").reduce((sum, pkg) => sum + pkg.downloads, 0)],
    ["total-crates", "crates", snapshot.packages.filter((pkg) => pkg.registry === "crates").reduce((sum, pkg) => sum + pkg.downloads, 0)],
  ] as const) {
    const target = element(id);
    target.textContent = snapshot.sources[source] === "ok" ? compact(value) : "—";
    target.title = snapshot.sources[source] === "ok" ? integer(value) : "Source unavailable";
  }
  const age = element("snapshot-age");
  const updated = time(snapshot.generatedAt);
  updated.textContent = new Date(snapshot.generatedAt).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }) + " UTC";
  age.replaceChildren(document.createTextNode("Snapshot "), updated);
  const errors = (Object.keys(SOURCE_NAMES) as Source[]).filter((source) => snapshot!.sources[source] === "error");
  const stale = Date.now() - Date.parse(snapshot.generatedAt) > 2 * 60 * 60 * 1000;
  const notice = element("notice");
  notice.hidden = !stale && errors.length === 0;
  notice.textContent = [stale ? "This snapshot is more than two hours old. Its original collection time is shown above." : "",
    errors.length ? `Some sources are unavailable: ${errors.map((source) => SOURCE_NAMES[source]).join(", ")}. Other metrics are still available.` : ""].filter(Boolean).join(" ");
  const registryUnavailable = snapshot.sources.npm !== "ok" || snapshot.sources.crates !== "ok";
  const githubOnly = projectFilter.querySelector<HTMLOptionElement>('option[value="github"]')!;
  githubOnly.disabled = registryUnavailable;
  if (registryUnavailable && projectFilter.value === "github") projectFilter.value = "all";
  renderSources(); renderProjects(); renderPackages();
  element("skill-total").textContent = snapshot.sources.skills === "ok" ? integer(snapshot.skills.length) : "—";
  element("skill-list").replaceChildren(...[...snapshot.skills].sort((a, b) => a.name.localeCompare(b.name)).map((skill) => {
    const row = node("li");
    row.append(link(skill.name, `https://github.com/${ORG}/skills.sebastian-software.com/tree/main/skills/${encodeURIComponent(skill.name)}`),
      node("span", "muted", `${integer(skill.references)} references`));
    return row;
  }));
  element("instruction-packs").textContent = snapshot.instructionPacks === null ? "Skills data is unavailable."
    : `${integer(snapshot.instructionPacks)} instruction packs are also available in the collection.`;
}

async function load() {
  refresh.disabled = true;
  refresh.querySelector("span")!.textContent = "Refreshing…";
  for (const id of ["overview", "projects", "packages", "skills-section"]) element(id).setAttribute("aria-busy", "true");
  element("error").hidden = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(ENDPOINT, { signal: controller.signal, cache: "no-cache", credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error("Metrics request failed");
    snapshot = parseSnapshot(await response.json());
    render();
  } catch {
    const error = element("error");
    error.hidden = false;
    error.textContent = snapshot ? "Refresh failed. The previous snapshot is still shown with its original collection time. Try Refresh data again."
      : "The public metrics snapshot could not be loaded. Check your connection and try Refresh data, or open the JSON snapshot.";
    if (!snapshot) {
      renderSources(true);
      element("snapshot-age").textContent = "Snapshot unavailable";
      element("projects-empty").replaceChildren(node("p", "", "Project data could not be loaded."));
      element("packages-empty").hidden = false;
      element("packages-empty").replaceChildren(node("p", "", "Package data could not be loaded."));
      element("package-results").textContent = "Package data could not be loaded";
      element("project-results").textContent = "Project data could not be loaded";
      element("instruction-packs").textContent = "Skills data could not be loaded.";
    }
  } finally {
    clearTimeout(timer);
    refresh.disabled = false;
    refresh.querySelector("span")!.textContent = "Refresh data";
    for (const id of ["overview", "projects", "packages", "skills-section"]) element(id).setAttribute("aria-busy", "false");
  }
}

projectSearch.addEventListener("input", renderProjects);
projectFilter.addEventListener("change", renderProjects);
projectSort.addEventListener("change", renderProjects);
for (const input of [packageSearch, packageRegistry]) input.addEventListener(input === packageSearch ? "input" : "change", () => { packagePage = 0; renderPackages(); });
previous.addEventListener("click", () => { packagePage--; renderPackages(); });
next.addEventListener("click", () => { packagePage++; renderPackages(); });
refresh.addEventListener("click", () => { void load(); });
renderSources();
void load();
