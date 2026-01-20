# Aquaculture Platform - Monitoring Stack

Bu dizin, Aquaculture Platform için observability altyapısını içerir.

## Bileşenler

### 1. Prometheus Stack
- **Prometheus**: Metrik toplama ve depolama
- **Alertmanager**: Alert yönetimi ve routing
- **Grafana**: Görselleştirme ve dashboard'lar
- **Node Exporter**: Node metrikleri
- **Kube State Metrics**: Kubernetes state metrikleri

### 2. Loki Stack
- **Loki**: Log agregasyonu
- **Promtail**: Log toplama agent'ı

## Kurulum

### Prerequisites
```bash
# Helm repo ekle
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

### Prometheus Stack Kurulumu
```bash
# Namespace oluştur
kubectl create namespace monitoring

# Prometheus stack kur
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f prometheus/prometheus-values.yaml

# Custom rules uygula
kubectl apply -f prometheus/aquaculture-rules.yaml
```

### Loki Stack Kurulumu
```bash
# Loki kur
helm install loki grafana/loki-stack \
  --namespace monitoring \
  -f loki/loki-values.yaml
```

### Grafana Dashboard'ları
```bash
# Dashboard ConfigMap oluştur
kubectl create configmap aquaculture-dashboards \
  --from-file=grafana/dashboards/ \
  --namespace monitoring

# Grafana'yı yeniden başlat
kubectl rollout restart deployment prometheus-grafana -n monitoring
```

## Erişim

### Grafana
```bash
# Port forward
kubectl port-forward svc/prometheus-grafana 3000:80 -n monitoring

# Varsayılan credentials (değiştirin!)
# Username: admin
# Password: kubectl get secret prometheus-grafana -n monitoring -o jsonpath="{.data.admin-password}" | base64 -d
```

### Prometheus
```bash
kubectl port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090 -n monitoring
```

### Alertmanager
```bash
kubectl port-forward svc/prometheus-kube-prometheus-alertmanager 9093:9093 -n monitoring
```

## Dashboard'lar

| Dashboard | Açıklama |
|-----------|----------|
| Aquaculture Overview | Platform genel durumu |
| Service Health | Servis sağlık metrikleri |
| Sensor Data | Sensör veri akışı |
| Alert Engine | Alert işleme metrikleri |

## Alert Kuralları

### Critical Alerts
- `ServiceDown`: Servis erişilemez
- `CriticalErrorRate`: >10% hata oranı
- `DatabaseConnectionPoolExhausted`: DB bağlantı havuzu dolu

### Warning Alerts
- `HighErrorRate`: >5% hata oranı
- `HighLatency`: >2s p95 latency
- `HighCPUUsage`: >80% CPU kullanımı
- `HighMemoryUsage`: >85% memory kullanımı

## Metrik Toplama

### Application Metrikleri
Uygulamalar `/metrics` endpoint'i üzerinden Prometheus formatında metrik sunar:

```typescript
// NestJS'de metrics endpoint
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
})
export class AppModule {}
```

### Custom Metrikler
```typescript
import { Counter, Histogram } from 'prom-client';

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5],
});

const sensorReadingsTotal = new Counter({
  name: 'sensor_readings_total',
  help: 'Total sensor readings processed',
  labelNames: ['sensor_type', 'status'],
});
```

## Log Format

Tüm servisler JSON formatında log üretmeli:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "message": "Request processed",
  "service": "gateway-api",
  "tenantId": "tenant-123",
  "traceId": "abc-123-xyz",
  "duration": 150,
  "method": "GET",
  "path": "/api/farms"
}
```

## Troubleshooting

### Prometheus hedef bulunamıyor
```bash
# ServiceMonitor'ları kontrol et
kubectl get servicemonitor -n aquaculture

# Prometheus hedeflerini kontrol et
kubectl port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090 -n monitoring
# Tarayıcıda: http://localhost:9090/targets
```

### Loki log almıyor
```bash
# Promtail pod'larını kontrol et
kubectl get pods -n monitoring -l app=promtail

# Promtail loglarını kontrol et
kubectl logs -n monitoring -l app=promtail
```
