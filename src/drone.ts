import { SpaceMoltAPI } from './api.js';

export const MINING_DEPOSIT_SCRIPT = `IF traveling()
  WAIT
ELSE IF cargo_full()
  IF at("sol_station")
    DEPOSIT
  ELSE
    MOVE "sol_station"
  END
ELSE
  IF at("sol_belt")
    MINE
  ELSE
    MOVE "sol_belt"
  END
END`;

export const COMBAT_PATROL_SCRIPT = `IF in_battle()
  IF hull_pct() < 30
    RETREAT
  ELSE
    STANCE "fire"
  END
ELSE IF enemy_nearby()
  ATTACK "nearest"
ELSE IF pirate_nearby()
  ATTACK "nearest"
ELSE
  WAIT
END`;

export const REPAIR_OWNER_SCRIPT = `IF owner_hull_pct() < 70
  REPAIR "owner"
ELSE
  WAIT
END`;

export const SALVAGE_WRECKS_SCRIPT = `IF traveling()
  WAIT
ELSE IF cargo_full()
  IF at("nebula_station")
    DEPOSIT
  ELSE
    MOVE "nebula_station"
  END
ELSE IF at("nebula_wrecks")
  IF tick() % 2 == 0
    LOOT "nearest"
  ELSE
    SALVAGE "nearest"
  END
ELSE
  MOVE "nebula_wrecks"
  END
END`;

export const SCOUT_PATROL_SCRIPT = `IF traveling()
  WAIT
ELSE IF tick() % 10 == 0
  SCAN
ELSE IF mem("phase") == "surveyed"
  WAIT
ELSE
  SET_MEM "phase" "surveyed"
  SURVEY
END`;

export async function uploadDroneScript(api: SpaceMoltAPI, droneId: string, script: string) {
  return api.execute('upload_drone_script', { drone_id: droneId, script });
}

export async function loadDrone(api: SpaceMoltAPI, itemId: string) {
  return api.execute('load_drone', { item_id: itemId });
}

export async function deployDrone(api: SpaceMoltAPI, droneId: string) {
  return api.execute('deploy_drone', { drone_id: droneId });
}

export async function recallDrone(api: SpaceMoltAPI, droneId: string) {
  return api.execute('recall_drone', { drone_id: droneId });
}

export async function getDrones(api: SpaceMoltAPI) {
  return api.execute('get_drones', {});
}

export async function getDrone(api: SpaceMoltAPI, droneId: string) {
  return api.execute('get_drone', { drone_id: droneId });
}
