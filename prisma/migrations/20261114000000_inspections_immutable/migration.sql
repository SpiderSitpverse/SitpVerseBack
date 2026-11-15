-- ESC-SEG-03: una inspección ya guardada NO se puede modificar ni borrar. La API nunca tuvo esas rutas; con este trigger
-- tampoco puede hacerlo el usuario de base de datos de la aplicación (ni por un error de código ni por acceso directo).
-- La hoja de vida del bus depende de que la inspección previa a un cambio de turno sea la que se registró ese día.

CREATE FUNCTION bus_inspections_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bus_inspections es de solo inserción (%): una inspección registrada no se modifica ni se borra', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bus_inspections_no_update_delete
  BEFORE UPDATE OR DELETE ON "bus_inspections"
  FOR EACH ROW EXECUTE FUNCTION bus_inspections_reject_change();
