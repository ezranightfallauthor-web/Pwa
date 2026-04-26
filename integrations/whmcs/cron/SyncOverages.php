<?php
/**
 * WHMCS Cron Example: pull overage report from VenueChat and stage for invoice workflows.
 *
 * Run via cron from WHMCS host.
 */

$apiBase = rtrim(getenv('VENUECHAT_API_BASE') ?: '', '/');
$apiKey = getenv('VENUECHAT_WHMCs_KEY') ?: '';
$outputFile = getenv('VENUECHAT_OVERAGE_OUTPUT') ?: __DIR__ . '/overage-report.json';

if (!$apiBase || !$apiKey) {
    fwrite(STDERR, "Missing VENUECHAT_API_BASE or VENUECHAT_WHMCs_KEY\n");
    exit(1);
}

$ch = curl_init($apiBase . '/api/system/whmcs/overage-report');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'x-whmcs-key: ' . $apiKey,
    ],
    CURLOPT_TIMEOUT => 20,
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($httpCode < 200 || $httpCode >= 300) {
    fwrite(STDERR, "VenueChat overage sync failed with status {$httpCode}\n");
    exit(2);
}

$payload = json_decode($response, true);
if (!is_array($payload)) {
    fwrite(STDERR, "Invalid JSON payload from VenueChat\n");
    exit(3);
}

file_put_contents($outputFile, json_encode($payload, JSON_PRETTY_PRINT));
echo "Synced overages for " . count($payload['users'] ?? []) . " users\n";
