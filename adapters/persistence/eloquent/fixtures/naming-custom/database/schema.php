<?php

use Illuminate\Database\Capsule\Manager as DB;
use Illuminate\Database\Schema\Blueprint;

DB::schema()->create('acme_heroes', function (Blueprint $table) {
    $table->id();
    $table->string('name');
});
