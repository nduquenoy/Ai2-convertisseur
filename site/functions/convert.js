// netlify/functions/convert.js
const JSZip = require('jszip');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');


const componentMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'component_map.json'), 'utf8'));

// Helper pour convertir un buffer en chaîne de caractères
const bufferToString = (buffer) => {
    return Buffer.from(buffer).toString('utf8');
};

/**
 * Point d'entrée de la fonction Netlify.
 * Reçoit le fichier AIA encodé en base64 via le corps de la requête POST.
 */
exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST' || !event.body) {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Méthode non autorisée ou corps manquant.' }),
        };
    }

    try {
        const data = JSON.parse(event.body);
        const base64Aia = data.file; // Le fichier AIA encodé en base64 depuis le front-end
        const projectName = data.projectName || 'ConvertedApp';
        
        if (!base64Aia) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Fichier AIA manquant.' }),
            };
        }

        const aiaBuffer = Buffer.from(base64Aia, 'base64');
        const zip = await JSZip.loadAsync(aiaBuffer);
        
        const convertedProject = await processAia(zip, projectName);

        // Création du fichier ZIP final à retourner au front-end
        const finalZip = new JSZip();
        for (const [path, content] of Object.entries(convertedProject)) {
            finalZip.file(path, content);
        }
        
        const finalZipBuffer = await finalZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        
        return {
            statusCode: 200,
            headers: {
                // Important pour le téléchargement côté client
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${projectName}.zip"`,
            },
            body: finalZipBuffer.toString('base64'),
            isBase64Encoded: true, // Indique que le corps est encodé en base64
        };

    } catch (error) {
        console.error('Erreur de conversion:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Erreur interne du serveur: ${error.message}` }),
        };
    }
};

/**
 * Logique principale de conversion
 * @param {JSZip} zip - L'objet JSZip du fichier AIA
 * @param {string} projectName - Nom du projet Android
 * @returns {Object} Un objet où la clé est le chemin du fichier et la valeur est son contenu.
 */
async function processAia(zip, projectName) {
    const projectFiles = {};
    let screen1Layout = '';
    let screen1Blocks = '';

    // --- 1. EXTRACTION DES FICHIERS CLÉS (SCM et BKY) ---
    
    // Parcourir les fichiers à la recherche de Screen1
    await zip.forEach(async (relativePath, zipEntry) => {
        if (relativePath.endsWith('Screen1.scm') && !zipEntry.dir) {
            // Lecture du fichier de Layout
            screen1Layout = bufferToString(await zipEntry.async('nodebuffer'));
        }
        if (relativePath.endsWith('Screen1.bky') && !zipEntry.dir) {
            // Lecture du fichier de Blocs (XML)
            screen1Blocks = bufferToString(await zipEntry.async('nodebuffer'));
        }
        // Ajouter ici la gestion des assets (images, sons)
        if (relativePath.startsWith('assets/') && !zipEntry.dir) {
             // Ajouter le fichier dans le dossier 'app/src/main/res/raw/' ou 'drawable/' du projet Kotlin
             projectFiles[`${projectName}/app/src/main/res/drawable/${zipEntry.name.split('/').pop()}`] = await zipEntry.async('nodebuffer');
        }
    });

    // --- 2. PARSING ET TRANSPILATION ---

    // A. Conversion SCM -> XML Layout
    const activityXml = convertLayoutToXml(screen1Layout);
    projectFiles[`${projectName}/app/src/main/res/layout/activity_main.xml`] = activityXml;

    // B. Conversion BKY -> Kotlin Code
    const mainActivityKotlin = await convertBlocksToKotlin(screen1Blocks);
    projectFiles[`${projectName}/app/src/main/java/com/example/${projectName.toLowerCase()}/MainActivity.kt`] = mainActivityKotlin;

    // --- 3. CRÉATION DES FICHIERS DE STRUCTURE ANDROID STUDIO ---

    // Fichier Manifest
    projectFiles[`${projectName}/app/src/main/AndroidManifest.xml`] = generateManifest(projectName);
    
    // Fichiers Gradle (Build scripts)
    projectFiles[`${projectName}/build.gradle`] = generateRootGradle();
    projectFiles[`${projectName}/app/build.gradle`] = generateAppGradle();
    
    // Ajoutez tous les autres fichiers nécessaires (res/values/strings.xml, etc.)

    return projectFiles;
}

function mapComponentToXml(componentType, properties = {}) {
    const mapEntry = componentMap[componentType];
    if (!mapEntry) return ''; // Aucun mapping trouvé

    const id = `@+id/${mapEntry.id_prefix}${Math.floor(Math.random() * 10000)}`;
    const xmlProps = [];

    // On parcourt les propriétés par défaut et celles fournies
    const allProps = { ...mapEntry.default_properties, ...properties };

    for (const [ai2Prop, androidAttr] of Object.entries(mapEntry.property_map)) {
        if (allProps[ai2Prop] !== undefined) {
            xmlProps.push(`${androidAttr}="${allProps[ai2Prop]}"`);
        }
    }

    return `<${mapEntry.xml_tag} ${xmlProps.join(' ')} />`;
}



// ----------------------------------------------------------------------
// Les fonctions de conversion réelles (le cœur de la logique)
// Ces fonctions doivent être implémentées pour gérer le mapping complexe
// ----------------------------------------------------------------------

/**
 * Simule la conversion SCM (Scheme App Inventor) en XML Android Layout.
 * Ceci est une simplification; la vraie fonction analyserait le format SCM.
 */
function convertLayoutToXml(scmContent) {
    // Exemple naïf : extraire tous les composants avec leur type et propriétés
    const componentMatches = scmContent.matchAll(/type\s+(\w+)(?:\s+properties\s+(\{.*?\}))?/g);

    const xmlComponents = [];
    for (const match of componentMatches) {
        const type = match[1];
        let props = {};
        try {
            props = match[2] ? JSON.parse(match[2]) : {};
        } catch(e) {
            console.warn(`Impossible de parser les propriétés pour ${type}`);
        }
        const xml = mapComponentToXml(type, props);
        if (xml) xmlComponents.push(xml);
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<androidx.constraintlayout.widget.ConstraintLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    xmlns:tools="http://schemas.android.com/tools"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    tools:context=".MainActivity">
    
    ${xmlComponents.join('\n    ')}

</androidx.constraintlayout.widget.ConstraintLayout>`;
}


/**
 * Convertit le XML des Blocs Blockly en code Kotlin lisible.
 * Ceci est la partie la plus difficile; la vraie fonction utiliserait 'xml2js'.
 */
async function convertBlocksToKotlin(bkyContent) {
    // Le parsing XML est nécessaire pour interpréter la structure des blocs
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(bkyContent);
    
    // Logique complexe ici :
    // - Parcourir result.xml.block pour identifier les événements (ex: Button.Click)
    // - Mapper chaque bloc Blockly (ex: math_arithmetic, controls_if) à une construction Kotlin.
    
    // Simplification pour la maquette :
    const kotlinCode = `package com.example.convertedapp

import androidx.appcompat.app.AppCompatActivity
import android.os.Bundle
import android.widget.TextView

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Logique Kotlin générée à partir des blocs App Inventor
        val statusText = findViewById<TextView>(R.id.textViewStatus)
        statusText.text = "Le code des blocs a été transpilé en Kotlin!"
        
        // Ex: Ajout d'un listener basé sur les blocs trouvés
        /*
        val myButton = findViewById<Button>(R.id.myButton)
        myButton.setOnClickListener {
            // Code généré pour le bloc "quand Button1.Clic faire..."
            statusText.text = "Bouton cliqué (Traduction du bloc Blockly)!"
        }
        */
    }
}
`;
    return kotlinCode;
}

// ----------------------------------------------------------------------
// Fonctions pour générer la structure de projet Android Studio
// ----------------------------------------------------------------------

function generateManifest(projectName) {
    return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.${projectName.toLowerCase()}">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppCompat.Light.DarkActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>`;
}

function generateRootGradle() {
    return `// Top-level build file where you can add configuration options common to all sub-projects/modules.
buildscript {
    ext.kotlin_version = "1.9.0"
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.2.0'
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"
    }
}

task clean(type: Delete) {
    delete rootProject.buildDir
}`;
}

function generateAppGradle() {
    return `plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android'
}

android {
    namespace 'com.example.convertedapp'
    compileSdk 34

    defaultConfig {
        applicationId 'com.example.convertedapp'
        minSdk 24
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }

    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = '1.8'
    }
}

dependencies {
    implementation 'androidx.core:core-ktx:1.12.0'
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'com.google.android.material:material:1.10.0'
    implementation 'androidx.constraintlayout:constraintlayout:2.1.4'
}
`;
}
