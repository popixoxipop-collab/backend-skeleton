<?php

use Illuminate\Database\Capsule\Manager as DB;
use Illuminate\Database\Schema\Blueprint;

DB::schema()->create('heroes', function (Blueprint $table) {
    $table->id();
    $table->string('name');
    $table->string('secret_name')->nullable();
});
