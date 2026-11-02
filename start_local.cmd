@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found in PATH. Install Node.js 22 or newer.
    exit /b 1
)

if not exist "dist\start.js" (
    echo dist\start.js was not found.
    echo Run "npm run build" once before starting the local service.
    exit /b 1
)

if not defined KAFKA_TESTING_REST_CLUSTER set "KAFKA_TESTING_REST_CLUSTER=localhost:9092"
if not defined KAFKA_TESTING_REST_HTTP_HOST set "KAFKA_TESTING_REST_HTTP_HOST=127.0.0.1"
if not defined KAFKA_TESTING_REST_HTTP_PORT set "KAFKA_TESTING_REST_HTTP_PORT=3000"
if not defined KAFKA_TESTING_REST_PUBLISHER_TOPICS set "KAFKA_TESTING_REST_PUBLISHER_TOPICS=[]"
if not defined KAFKA_TESTING_REST_AUTO_DELETE_SLOTS_SECONDS set "KAFKA_TESTING_REST_AUTO_DELETE_SLOTS_SECONDS=300"
if not defined KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS set "KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS=3600"
if not defined KAFKA_TESTING_REST_CONSUMER_GROUP_PREFIX set "KAFKA_TESTING_REST_CONSUMER_GROUP_PREFIX=testing-REST-API"
if not defined KAFKA_TESTING_REST_DEFAULT_WAIT_SECONDS set "KAFKA_TESTING_REST_DEFAULT_WAIT_SECONDS=60"

echo Starting KafkaTestingREST on %KAFKA_TESTING_REST_HTTP_HOST%:%KAFKA_TESTING_REST_HTTP_PORT%.
echo Kafka cluster: %KAFKA_TESTING_REST_CLUSTER%
start node dist\start.js
exit /b %ERRORLEVEL%
