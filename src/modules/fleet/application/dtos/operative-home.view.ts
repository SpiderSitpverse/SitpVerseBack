/** Vista del Home de un usuario operativo: solo el bus que tiene asignado (HU-11). */
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
