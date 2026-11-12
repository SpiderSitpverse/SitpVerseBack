-- Política de retención. Las tablas de trazabilidad siguen siendo de SOLO INSERCIÓN: UPDATE está prohibido siempre, y DELETE
-- solo se permite sobre filas que ya superaron su plazo MÍNIMO de conservación. Así ni un error de la aplicación ni un
-- acceso directo a la base pueden borrar registros recientes, pero la tabla no crece sin límite.
--   request_log (todas las peticiones, mucho volumen): se pueden borrar los de más de 7 días  (la app conserva 14 por defecto).
--   audit_log   (acciones críticas, poco volumen):    se pueden borrar los de más de 365 días (la app conserva 730 por defecto).

CREATE OR REPLACE FUNCTION request_log_reject_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."at" < now() - interval '7 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'request_log es de solo inserción (%): solo se borran registros de más de 7 días', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_log_reject_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."at" < now() - interval '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log es de solo inserción (%): solo se borran registros de más de 365 días', TG_OP;
END;
$$ LANGUAGE plpgsql;
