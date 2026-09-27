import { IsLatitude, IsLongitude } from 'class-validator';

export class UpdatePositionDto {
  @IsLatitude()
  latitude: number;

  @IsLongitude()
  longitude: number;
}
