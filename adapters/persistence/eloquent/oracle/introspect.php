<?php
// Offline oracle for the eloquent scope record.
//
// Loads one fixture directory (database/schema.php and app/Models/**/*.php) into an in-memory SQLite database
// with illuminate/database and prints, as JSON on stdout, the physical schema facts of the Eloquent model
// classes the fixture defines (tables, columns, primary keys, foreign keys), plus the versions of the runtime
// and library that produced them. No file or network database is opened.
ini_set('display_errors', 'stderr');
error_reporting(E_ALL);

// sha256 of this script and of every file the fixture argument names (the file, or every file under a directory), keyed by the path as given.
function input_digests(string $script, string $target): array
{
    $names = [$script];
    if (is_dir($target)) {
        foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($target, FilesystemIterator::SKIP_DOTS)) as $file) {
            if ($file->isFile()) {
                $names[] = $file->getPathname();
            }
        }
    } else {
        $names[] = $target;
    }
    $digests = [];
    foreach ($names as $name) {
        $digests[$name] = hash_file('sha256', $name);
    }
    ksort($digests, SORT_STRING);
    return $digests;
}

$consumed = input_digests($argv[0], $argv[1]); // before the fixture is loaded
require $argv[2];

use Illuminate\Database\Capsule\Manager as DB;
use Illuminate\Database\Eloquent\Model;

$root = realpath($argv[1]);
$capsule = new DB();
$capsule->addConnection(['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']);
$capsule->setAsGlobal();
$capsule->bootEloquent();

require $root . '/database/schema.php';
$before = get_declared_classes();
$paths = [];
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/app/Models', FilesystemIterator::SKIP_DOTS)) as $file) {
    if ($file->isFile() && $file->getExtension() === 'php') {
        $paths[] = $file->getPathname();
    }
}
sort($paths);
foreach ($paths as $path) {
    require_once $path;
}
$models = array_values(array_filter(array_diff(get_declared_classes(), $before), fn ($class) => is_subclass_of($class, Model::class)));

$schema = DB::schema();
$tables = $columns = $primaryKeys = $foreignKeys = $unmodeled = [];
foreach ($models as $class) {
    $model = new $class();
    $table = $model->getTable();
    if (!$schema->hasTable($table)) {
        throw new RuntimeException("table $table of $class is not in the fixture schema");
    }
    $tables[] = $table;
    foreach ($schema->getColumnListing($table) as $name) {
        $columns[] = "$table.$name";
    }
    $keyColumns = [];
    $hasPlainIndex = false;
    foreach ($schema->getIndexes($table) as $index) {
        if ($index['primary']) {
            $keyColumns = $index['columns'];
        } else {
            $hasPlainIndex = true;
        }
    }
    if ($keyColumns) {
        $primaryKeys[] = "$table(" . implode(',', $keyColumns) . ')';
    }
    if (count($keyColumns) > 1) {
        $unmodeled[] = 'single-key-model-over-composite-primary-key';
    }
    foreach ($schema->getForeignKeys($table) as $key) {
        $foreignKeys[] = "$table(" . implode(',', $key['columns']) . ")->{$key['foreign_table']}(" . implode(',', $key['foreign_columns']) . ')';
    }
    if ($hasPlainIndex) {
        $unmodeled[] = 'create-index';
    }
    if (count($model->getGlobalScopes()) > 0) {
        $unmodeled[] = 'global-scope';
    }
}
$list = function (array $items): array {
    $items = array_values(array_unique($items));
    sort($items, SORT_STRING);
    return $items;
};
$result = [
    'facts' => ['columns' => $list($columns), 'foreign_keys' => $list($foreignKeys), 'primary_keys' => $list($primaryKeys), 'tables' => $list($tables), 'unmodeled' => $list($unmodeled)],
    'inputs' => $consumed,
    'oracle' => 'eloquent-sqlite-memory',
    'versions' => ['illuminate/database' => ltrim(\Composer\InstalledVersions::getPrettyVersion('illuminate/database'), 'v'), 'php' => PHP_VERSION],
];
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
