// fleet.ts - In-game fleet coordination system
// Provides fleet creation, joining, status tracking, and movement commands

import type { RoutineContext } from "../bot.js";

export interface FleetMember {
  player_id: string;
  username: string;
  is_leader: boolean;
  system_id?: string;
  poi_id?: string;
  ship?: Record<string, unknown>;
  modules?: Array<Record<string, unknown>>;
  fuel_per_jump?: number;
  cargo?: Array<Record<string, unknown>>;
}

export interface FleetStatusResponse {
  action: string;
  in_fleet: boolean;
  fleet_id: string;
  leader: string;
  is_leader: boolean;
  members: FleetMember[];
  max_size: number;
  system_id: string;
  poi_id: string;
  pending_invite?: boolean;
  invites?: Array<{ player_id: string; username: string }>;
}

export interface FleetCreateResponse {
  action: string;
  fleet_id: string;
  max_size: number;
  message: string;
}

export interface FleetInviteResponse {
  action: string;
  fleet_id: string;
  message: string;
  invited: string[];
}

export async function fleetCreate(ctx: RoutineContext): Promise<{ success: boolean; fleetId?: string; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "create" });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetCreateResponse) || result;
  return {
    success: true,
    fleetId: structuredContent.fleet_id as string,
    message: structuredContent.message as string,
  };
}

export async function fleetStatus(ctx: RoutineContext): Promise<FleetStatusResponse | null> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "status" });
  if (resp.error) {
    return null;
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetStatusResponse) || result;
  return structuredContent;
}

export async function fleetInvite(ctx: RoutineContext, playerId: string): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "invite", id: playerId });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetInviteResponse) || result;
  return {
    success: true,
    message: structuredContent.message as string,
  };
}

export async function fleetKick(ctx: RoutineContext, playerId: string): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "kick", id: playerId });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetInviteResponse) || result;
  return {
    success: true,
    message: structuredContent.message as string,
  };
}

export async function fleetLeave(ctx: RoutineContext): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "leave" });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetInviteResponse) || result;
  return {
    success: true,
    message: structuredContent.message as string,
  };
}

export async function fleetDisband(ctx: RoutineContext): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "disband" });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetInviteResponse) || result;
  return {
    success: true,
    message: structuredContent.message as string,
  };
}

export async function fleetAccept(ctx: RoutineContext): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "accept" });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetInviteResponse) || result;
  return {
    success: true,
    message: structuredContent.message as string,
  };
}

export async function fleetDecline(ctx: RoutineContext): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "decline" });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  const result = resp.result as Record<string, unknown>;
  const structuredContent = (result?.structuredContent as FleetInviteResponse) || result;
  return {
    success: true,
    message: structuredContent.message as string,
  };
}

export async function fleetJump(ctx: RoutineContext, targetSystem: string): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "jump", target_system: targetSystem });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  return { success: true, message: "Fleet jump commanded" };
}

export async function fleetDock(ctx: RoutineContext): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "dock" });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  return { success: true, message: "Fleet dock commanded" };
}

export async function fleetUndock(ctx: RoutineContext): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const resp = await bot.exec("fleet", { action: "undock" });
  if (resp.error) {
    return { success: false, message: resp.error.message };
  }
  return { success: true, message: "Fleet undock commanded" };
}

export function getFleetMemberByUsername(status: FleetStatusResponse | null, username: string): FleetMember | null {
  if (!status?.members) return null;
  const lower = username.toLowerCase();
  return status.members.find(m => m.username.toLowerCase() === lower) || null;
}

export function isFleetLeader(status: FleetStatusResponse | null, username: string): boolean {
  if (!status) return false;
  if (status.is_leader) return true;
  const member = getFleetMemberByUsername(status, username);
  return member?.is_leader ?? false;
}