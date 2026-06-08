export interface StationInfo {
  station_id: string;
  system_id: string;
  official_name: string;
  official_system_name: string;
  regular_system_name: string;
  regular_station_name: string;
  underline_system_name: string;
  underline_station_name: string;
  is_pirate: boolean;
}

export interface PassengerDestination {
  destination: string;
  destination_name: string;
  destination_system: string;
  station_id: string;
  system_id: string;
  is_pirate: boolean;
}

export interface StationRef {
  stations: StationInfo[];
  passenger_destinations: PassengerDestination[];
  by_station_id: Record<string, StationInfo>;
  by_system_id: Record<string, StationInfo>;
  by_underline_name: Record<string, StationInfo>;
  pirate_stations: Array<Omit<StationInfo, keyof PassengerDestination>>;
}