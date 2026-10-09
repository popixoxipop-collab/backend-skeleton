<?php

use Illuminate\Database\Capsule\Manager as DB;
use Illuminate\Database\Schema\Blueprint;

DB::schema()->create('invoices', function (Blueprint $table) {
    $table->id();
    $table->unsignedInteger('tenant_id')->index();
    $table->unsignedInteger('total_cents');
});
