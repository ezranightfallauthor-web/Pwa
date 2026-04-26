<?php
/**
 * WHMCS Hook Example: Provision or update VenueChat user on client lifecycle events.
 *
 * Place under WHMCS includes/hooks/.
 */

use WHMCS\Database\Capsule;

if (!function_exists('venuechat_post_json')) {
    function venuechat_post_json($url, $payload, $apiKey)
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'x-whmcs-key: ' . $apiKey,
            ],
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_TIMEOUT => 15,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [$httpCode, $response];
    }
}

if (!function_exists('venuechat_extract_plan')) {
    function venuechat_extract_plan($clientId)
    {
        // Example mapping logic; customize with your product/plan rules.
        // Return: starter | pro | enterprise
        $activeServices = Capsule::table('tblhosting')->where('userid', $clientId)->where('domainstatus', 'Active')->count();
        if ($activeServices > 20) return 'enterprise';
        if ($activeServices > 5) return 'pro';
        return 'starter';
    }
}

add_hook('ClientAdd', 1, function ($vars) {
    $apiBase = rtrim(getenv('VENUECHAT_API_BASE') ?: '', '/');
    $apiKey = getenv('VENUECHAT_WHMCs_KEY') ?: '';
    if (!$apiBase || !$apiKey) return;

    $email = $vars['email'] ?? null;
    $clientId = $vars['userid'] ?? null;
    if (!$email || !$clientId) return;

    $payload = [
        'email' => strtolower(trim($email)),
        'role' => 'user',
        'planId' => venuechat_extract_plan($clientId),
        'venueIds' => [], // Optional: map WHMCS products to venue IDs
    ];

    venuechat_post_json($apiBase . '/api/system/whmcs/provision-user', $payload, $apiKey);
});

add_hook('ClientEdit', 1, function ($vars) {
    $apiBase = rtrim(getenv('VENUECHAT_API_BASE') ?: '', '/');
    $apiKey = getenv('VENUECHAT_WHMCs_KEY') ?: '';
    if (!$apiBase || !$apiKey) return;

    $email = $vars['email'] ?? null;
    $clientId = $vars['userid'] ?? null;
    if (!$email || !$clientId) return;

    $payload = [
        'email' => strtolower(trim($email)),
        'role' => 'user',
        'planId' => venuechat_extract_plan($clientId),
        'venueIds' => [],
    ];

    venuechat_post_json($apiBase . '/api/system/whmcs/provision-user', $payload, $apiKey);
});
