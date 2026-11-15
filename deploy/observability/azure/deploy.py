"""
Despliega Prometheus + Grafana de SitpVerse en Azure Container Instances (ESC-OBS-01): un host APARTE del sistema, con
los dos tableros (técnico y de negocio) detrás de usuario y contraseña.

    METRICS_TOKEN=...  GRAFANA_ADMIN_PASSWORD=...  python deploy/observability/azure/deploy.py

Variables:
    METRICS_TOKEN            el mismo valor que la variable METRICS_TOKEN del App Service (Prometheus lo manda como Bearer)
    GRAFANA_ADMIN_PASSWORD   contraseña del usuario `admin` de Grafana
    RESOURCE_GROUP           por defecto sitpverse2026-rg
    API_HOST                 por defecto sitpverse2026-api.azurewebsites.net
    NAME                     por defecto sitpverse2026-obs  (queda en http://<NAME>.<región>.azurecontainer.io:3000)
    LOCATION                 por defecto westus3

Los secretos NO se escriben en el repositorio: viajan en el YAML temporal que se le pasa a `az` y se borra al terminar.
Prometheus no se expone a internet: solo Grafana (puerto 3000) lo consulta, dentro del mismo grupo de contenedores.
"""
import base64
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
OBS = HERE.parent

token = os.environ.get('METRICS_TOKEN')
password = os.environ.get('GRAFANA_ADMIN_PASSWORD')
if not token or not password:
    sys.exit('Faltan METRICS_TOKEN y/o GRAFANA_ADMIN_PASSWORD')

group = os.environ.get('RESOURCE_GROUP', 'sitpverse2026-rg')
api_host = os.environ.get('API_HOST', 'sitpverse2026-api.azurewebsites.net')
name = os.environ.get('NAME', 'sitpverse2026-obs')
location = os.environ.get('LOCATION', 'westus3')


def b64(text: str) -> str:
    return base64.b64encode(text.encode('utf-8')).decode('ascii')


def read(relative: str) -> str:
    return (OBS / relative).read_text(encoding='utf-8')


prometheus = f"""global:
  scrape_interval: 10s
  scrape_timeout: 8s
scrape_configs:
  - job_name: sitpverse-api
    scheme: https
    metrics_path: /metrics
    honor_labels: true
    authorization:
      type: Bearer
      credentials: {token}
    static_configs:
      - targets: ['{api_host}']
"""

datasource = read('grafana/provisioning/datasources/prometheus.yml').replace('${PROMETHEUS_URL}', 'http://localhost:9090')


def secret_volume(volume: str, files: dict) -> str:
    lines = [f'  - name: {volume}', '    secret:']
    lines += [f'      {filename}: {b64(content)}' for filename, content in files.items()]
    return '\n'.join(lines)


volumes = '\n'.join([
    secret_volume('prometheus-config', {'prometheus.yml': prometheus}),
    secret_volume('grafana-datasources', {'prometheus.yml': datasource}),
    secret_volume('grafana-providers', {'sitpverse.yml': read('grafana/provisioning/dashboards/sitpverse.yml')}),
    secret_volume('grafana-dashboards', {
        'tecnico.json': read('grafana/dashboards/tecnico.json'),
        'negocio.json': read('grafana/dashboards/negocio.json'),
    }),
])

manifest = f"""apiVersion: '2021-10-01'
location: {location}
name: {name}
type: Microsoft.ContainerInstance/containerGroups
properties:
  osType: Linux
  restartPolicy: Always
  ipAddress:
    type: Public
    dnsNameLabel: {name}
    ports:
      - protocol: tcp
        port: 3000
  containers:
    - name: prometheus
      properties:
        image: prom/prometheus:v2.54.1
        command: ['/bin/prometheus', '--config.file=/etc/prometheus-config/prometheus.yml', '--storage.tsdb.path=/prometheus', '--storage.tsdb.retention.time=3d', '--web.listen-address=127.0.0.1:9090']
        resources:
          requests:
            cpu: 0.5
            memoryInGb: 1
        volumeMounts:
          - name: prometheus-config
            mountPath: /etc/prometheus-config
    - name: grafana
      properties:
        image: grafana/grafana:11.2.0
        ports:
          - port: 3000
        environmentVariables:
          - name: GF_SECURITY_ADMIN_USER
            value: admin
          - name: GF_SECURITY_ADMIN_PASSWORD
            secureValue: {password}
          - name: GF_AUTH_ANONYMOUS_ENABLED
            value: 'false'
          - name: GF_USERS_ALLOW_SIGN_UP
            value: 'false'
          - name: GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH
            value: /var/lib/grafana-dashboards/tecnico.json
        resources:
          requests:
            cpu: 0.5
            memoryInGb: 1
        volumeMounts:
          - name: grafana-datasources
            mountPath: /etc/grafana/provisioning/datasources
          - name: grafana-providers
            mountPath: /etc/grafana/provisioning/dashboards
          - name: grafana-dashboards
            mountPath: /var/lib/grafana-dashboards
  volumes:
{volumes}
"""
# En el contenedor los tableros quedan en /var/lib/grafana-dashboards (el volumen de secretos es de solo lectura).
manifest = manifest.replace(b64(read('grafana/provisioning/dashboards/sitpverse.yml')),
                            b64(read('grafana/provisioning/dashboards/sitpverse.yml').replace('/var/lib/grafana/dashboards', '/var/lib/grafana-dashboards')))

with tempfile.TemporaryDirectory() as folder:
    path = pathlib.Path(folder) / 'aci.yaml'
    path.write_text(manifest, encoding='utf-8')
    az = 'az.cmd' if os.name == 'nt' else 'az'
    result = subprocess.run([az, 'container', 'create', '--resource-group', group, '--file', str(path),
                             '--query', 'ipAddress.fqdn', '--output', 'tsv'], capture_output=True, text=True)
if result.returncode != 0:
    sys.exit(result.stderr.strip()[-2000:])
print(f'Grafana: http://{result.stdout.strip()}:3000  (usuario admin)')
