import type { Device } from "./types.js";

/**
 * Registered-Ring-device directory. Multi-device support (front door, back
 * door, garage, ...) needs *some* place to record "this deviceId exists and
 * here's a friendly name for it" — but forcing an explicit setup step before
 * a device can be used would be one more thing a homeowner has to remember
 * to do before the feature that actually matters (scoping a pass to a
 * device) works at all. So registration is implicit by default: the first
 * pass that names a `deviceId` in its `deviceIds`, or the first Ring event
 * that arrives for one, registers it right then with a humanized name
 * derived from the id (`"back-door"` -> `"Back Door"`). `POST /devices`
 * exists for a homeowner who wants to register (or rename) one explicitly,
 * e.g. to give it a nicer name than the id would produce on its own, before
 * anything else references it.
 *
 * Single in-memory `Map`, same tradeoff as `store.ts` and `settings.ts` —
 * fine for a single-instance hackathon deployment.
 */

export const FRONT_DOOR_DEVICE_ID = "front-door";

const devices = new Map<string, Device>();

function humanize(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export interface RegisterDeviceOptions {
  name?: string;
  via?: Device["registeredVia"];
}

/**
 * Registers a device if it isn't already known, otherwise returns (and,
 * if an explicit `name` is given, updates) the existing record. Idempotent
 * by design — both `passService.issuePass` and `SimulatedRingClient.emitEvent`
 * call this unconditionally every time they see a `deviceId`, rather than
 * checking "is this new?" themselves first.
 */
export function registerDevice(id: string, options: RegisterDeviceOptions = {}): Device {
  const existing = devices.get(id);
  if (existing) {
    if (options.name && options.name !== existing.name) {
      const renamed: Device = { ...existing, name: options.name };
      devices.set(id, renamed);
      return renamed;
    }
    return existing;
  }
  const device: Device = {
    id,
    name: options.name ?? humanize(id),
    registeredAt: new Date().toISOString(),
    registeredVia: options.via ?? "explicit",
  };
  devices.set(id, device);
  return device;
}

export function listDevices(): Device[] {
  return [...devices.values()].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
}

export function getDevice(id: string): Device | undefined {
  return devices.get(id);
}

// Pre-registered so a deployment that never touches multi-device support at
// all still sees exactly the device it always implicitly had, in
// `GET /devices`, from the moment the server starts.
registerDevice(FRONT_DOOR_DEVICE_ID, { name: "Front Door", via: "explicit" });
