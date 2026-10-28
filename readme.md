# Тестовый сервис для тесирования через Kafka

## API

### Конфигурация 

cluster: "localhost:9092"
publisherTopics: [
  "regEx1",...,"regExN"
]
autoDeleteSlotsSeconds: int

Публиковать можно только в топики, попадающие под один из regex

если autoDeleteSlotsSeconds не указан, тьо 1 минута

### Publishing 

Используется API Kafka REST  

POST /api/v1/topics/{name}/records

Формат сообщения

``` json
  "headers": [
        {
            "name": "Header-1",
            "value": "SGVhZGVyLTE="
        },
        {
            "name": "Header-2",
            "value": "SGVhZGVyLTI="
        }
    ],
    "key": {
        "type": "BINARY",
        "data": "Zm9vYmFy"
    },
    "value": {
        "type": "JSON",
        "data": {
            "foo": "bar"
        }
    },
}
```

### Проверка/чтение записей

Перед началом операции регистрируется слот, с проверками, обычно через correlationId. С момента регистрации слота, 
результаты проверок начнают заполняться.
Затем инициируется операция и потом проверяются результаты проверок, с возможностью ожидания.

POST  /api/v1/slots

Body:

``` json
{
   "slotId": string,
   "topic": string,
   "autoDeleteSeconds": int,
   "checks" : [
		{
			"headers" : [
				{
					"name": string 
                    "value": string   				
				},
			],	
			"values" : [
				{
					"jsonPath" : string
					"value": string
				}
			]				
		}
   ] 
}
```
