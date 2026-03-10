# Hurricane Center PR — APRS-IS Server

Servidor Node.js que se conecta a la red APRS-IS, filtra estaciones meteorológicas CWOP de Puerto Rico, y expone una API REST para la PWA.

## Deploy en Render

1. Sube este repositorio a GitHub
2. En Render → New Web Service → conecta tu repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Plan: Free

## UptimeRobot

Configura UptimeRobot para hacer ping a `https://tu-app.onrender.com/` cada 5 minutos para evitar que el servidor se duerma.

## Endpoints

### GET /
Health check. Retorna estado de conexión APRS-IS.

### GET /cwop
Retorna todas las estaciones activas (datos frescos <45 min).

### GET /cwop/batch?ids=CW4917,TJSJ
Retorna estaciones específicas por ID.

## Integración con la PWA

En lugar de llamar a aprs.fi, la app llama a:
```
https://tu-app.onrender.com/cwop/batch?ids=CW4917,CW5930,...
```

## Cómo funciona

- Conecta a `rotate.aprs2.net:14580` (APRS-IS público, gratis, sin límites)
- Filtra paquetes tipo weather en radio de 250km alrededor de PR
- Parsea paquetes APRS en formato WX
- Keepalive cada 10 min para mantener la conexión
- Purga datos >2 horas cada 30 min
- Datos con >45 min se excluyen del endpoint `/cwop`
