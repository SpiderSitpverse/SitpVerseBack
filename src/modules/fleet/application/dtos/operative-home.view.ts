/**
 * "validar la información mostrada según el usuario operativo".
 */
export interface OperativeHomeView {
  busId: string;
  plate: string;
  route: string;
  status: string;
  hasActiveTrip: boolean;
  latitude: number | null;
  longitude: number | null;
  updatedAt: string;
}