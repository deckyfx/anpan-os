import { Layers, Box, Power, Heart, Database, List, Cpu, MemoryStick } from "lucide-react";
import type { DockerSummary } from "../pages/home/types";

/**
 * Host-wide Docker totals, shown above the dashboard grids.
 *
 * Deliberately separate from the per-section headers: those counts follow the search
 * filter and describe what is on screen, whereas everything here is a fact about the host
 * and never changes with a filter. Mixing the two in one line would make both ambiguous.
 */

/** Bytes → "29.2 GB". Decimal units, matching how RAM is normally quoted. */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * One icon + value pair.
 *
 * `title` is both the hover tooltip and the accessible name. Several metrics here render
 * as a bare number whose meaning is carried only by the icon and its colour — "45, 0, 14"
 * announced on its own is meaningless, and colour alone is not available to every reader.
 * The label is therefore rendered for assistive technology and the icon marked decorative,
 * so the svg is not announced in its place.
 */
function Metric({ icon, children, title }: {
  icon: React.ReactNode;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" title={title}>
      <span aria-hidden="true" className="flex items-center">{icon}</span>
      {title && <span className="sr-only">{title}: </span>}
      <span>{children}</span>
    </span>
  );
}

export function DockerSummaryBar({ summary }: { summary: DockerSummary | null }) {
  // Render nothing until the first poll lands — a bar full of zeroes reads as a broken
  // host rather than as "not loaded yet".
  if (!summary) return null;

  const { containers, health } = summary;
  const iconCls = "shrink-0";

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-500 mb-5">

      <Metric icon={<Layers size={14} className={iconCls} />} title="Compose projects">
        {summary.stacks} {summary.stacks === 1 ? "stack" : "stacks"}
      </Metric>

      <Metric icon={<Box size={14} className={iconCls} />} title="All containers, running or not">
        {containers.total} {containers.total === 1 ? "container" : "containers"}
      </Metric>

      <span className="flex items-center gap-3">
        <Metric icon={<Power size={13} className="shrink-0 text-green-500" />} title="Running">
          {containers.running}
        </Metric>
        <Metric icon={<Power size={13} className="shrink-0 text-gray-600" />} title="Stopped">
          {containers.stopped}
        </Metric>
        {containers.paused > 0 && (
          <Metric icon={<Power size={13} className="shrink-0 text-amber-500" />} title="Paused">
            {containers.paused}
          </Metric>
        )}
      </span>

      {/* Health only exists for containers declaring a HEALTHCHECK, so these never sum to
          the container total — shown only when something actually reports health. */}
      {(health.healthy > 0 || health.unhealthy > 0 || health.starting > 0) && (
        <span className="flex items-center gap-3">
          {health.healthy > 0 && (
            <Metric icon={<Heart size={13} className="shrink-0 text-green-500" />} title="Healthy">
              {health.healthy}
            </Metric>
          )}
          {health.unhealthy > 0 && (
            <Metric icon={<Heart size={13} className="shrink-0 text-red-500" />} title="Unhealthy">
              {health.unhealthy}
            </Metric>
          )}
          {health.starting > 0 && (
            <Metric icon={<Heart size={13} className="shrink-0 text-amber-500" />} title="Health check starting">
              {health.starting}
            </Metric>
          )}
        </span>
      )}

      <Metric icon={<Database size={14} className={iconCls} />} title="Docker volumes">
        {summary.volumes} {summary.volumes === 1 ? "volume" : "volumes"}
      </Metric>

      <Metric icon={<List size={14} className={iconCls} />} title="Docker images">
        {summary.images} {summary.images === 1 ? "image" : "images"}
      </Metric>

      <Metric icon={<Cpu size={14} className={iconCls} />} title="Logical CPUs">
        {summary.cpus} CPU
      </Metric>

      <Metric icon={<MemoryStick size={14} className={iconCls} />} title="Total host memory">
        {formatBytes(summary.memTotal)} RAM
      </Metric>

    </div>
  );
}
