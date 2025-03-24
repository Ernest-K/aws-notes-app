import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { Sequelize, DataTypes } from "sequelize";
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  GetUserCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// Konfiguracja bazy danych
// const sequelize = new Sequelize(process.env.DB_URL, {
//   dialect: "postgres",
//   logging: false,
// });

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: ":memory:",
  logging: false, // Wyłącz logowanie zapytań
});

const Note = sequelize.define(
  "Note",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    cognitoId: {
      type: DataTypes.STRING,
      unique: true,
    },
    email: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    timestamps: true,
  }
);

// Relacje
Note.belongsTo(User, { foreignKey: "userId", as: "author" });
User.hasMany(Note, { foreignKey: "userId", as: "notes" });

sequelize.sync();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

// Inicjalizacja klienta Cognito
const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Inicjalizacja klienta CloudWatch
const cloudWatchClient = new CloudWatchClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

// Inicjalizacja klienta CloudWatch Logs
const cloudWatchLogsClient = new CloudWatchLogsClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

// Nazwa aplikacji dla metryk CloudWatch
const appName = process.env.APP_NAME || "notes-app";
const logGroupName = `/aws/app/${appName}`;
const logStreamName = `${appName}-logs-${new Date().toISOString().split("T")[0]}`;

// Inicjalizacja grup logów i strumieni
async function initializeCloudWatchLogs() {
  try {
    // Utworzenie grupy logów (jeśli nie istnieje)
    await cloudWatchLogsClient.send(
      new CreateLogGroupCommand({
        logGroupName: logGroupName,
      })
    );
    console.log(`CloudWatch Logs group ${logGroupName} created or already exists`);
  } catch (error) {
    // Ignorowanie błędu, jeśli grupa logów lub strumień już istnieją
    if (error.name !== "ResourceAlreadyExistsException") {
      console.error("Error initializing CloudWatch Logs:", error);
    }
  }

  try {
    // Utworzenie strumienia logów
    await cloudWatchLogsClient.send(
      new CreateLogStreamCommand({
        logGroupName: logGroupName,
        logStreamName: logStreamName,
      })
    );
    console.log(`CloudWatch Log stream ${logStreamName} created`);
  } catch (error) {
    // Ignorowanie błędu, jeśli grupa logów lub strumień już istnieją
    if (error.name !== "ResourceAlreadyExistsException") {
      console.error("Error initializing CloudWatch Logs:", error);
    }
  }
}

// Inicjalizacja CloudWatch Logs przy starcie aplikacji
initializeCloudWatchLogs();

// Middleware do zapisywania logów w CloudWatch
const loggerMiddleware = async (req, res, next) => {
  const start = Date.now();
  const requestId = uuidv4();

  // Zapisujemy informacje o początku żądania
  await logToCloudWatch({
    message: `Request started: ${req.method} ${req.url}`,
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    level: "INFO",
  });

  // Monitorujemy odpowiedź
  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;

    // Zapisujemy informacje o zakończeniu żądania
    logToCloudWatch({
      message: `Request completed: ${req.method} ${req.url}`,
      requestId,
      method: req.method,
      url: req.url,
      statusCode,
      duration,
      level: statusCode >= 400 ? "ERROR" : "INFO",
    });

    // Wysyłamy metryki do CloudWatch
    sendMetricToCloudWatch("RequestDuration", duration, "Milliseconds", {
      Path: req.path,
      Method: req.method,
      StatusCode: statusCode.toString(),
    });

    sendMetricToCloudWatch("RequestCount", 1, "Count", {
      Path: req.path,
      Method: req.method,
      StatusCode: statusCode.toString(),
    });

    return originalSend.call(this, body);
  };

  next();
};

// Używamy middleware do logowania
app.use(loggerMiddleware);

// Funkcja do zapisywania logów w CloudWatch
async function logToCloudWatch(logData) {
  try {
    const timestamp = new Date().getTime();
    const logEvent = {
      timestamp,
      message: JSON.stringify({
        timestamp: new Date(timestamp).toISOString(),
        ...logData,
      }),
    };

    const params = {
      logGroupName: logGroupName,
      logStreamName: logStreamName,
      logEvents: [logEvent],
    };

    await cloudWatchLogsClient.send(new PutLogEventsCommand(params));
  } catch (error) {
    console.error("Error sending logs to CloudWatch:", error);
  }
}

// Funkcja do wysyłania metryk do CloudWatch
async function sendMetricToCloudWatch(metricName, value, unit, dimensions = {}) {
  try {
    const dimensionsArray = Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value }));

    const params = {
      MetricData: [
        {
          MetricName: metricName,
          Dimensions: dimensionsArray,
          Unit: unit,
          Value: value,
          Timestamp: new Date(),
        },
      ],
      Namespace: `${appName}/metrics`,
    };

    await cloudWatchClient.send(new PutMetricDataCommand(params));
  } catch (error) {
    console.error("Error sending metric to CloudWatch:", error);
  }
}

// Middleware do obsługi błędów
app.use((err, req, res, next) => {
  const errorMessage = err.message || "Wystąpił nieznany błąd";
  console.error(err);

  // Logujemy błąd do CloudWatch
  logToCloudWatch({
    message: `Error: ${errorMessage}`,
    stack: err.stack,
    url: req.url,
    method: req.method,
    level: "ERROR",
  });

  // Wysyłamy metrykę dotyczącą błędu
  sendMetricToCloudWatch("ErrorCount", 1, "Count", {
    ErrorType: err.name || "UnknownError",
    Path: req.path,
  });

  res.status(500).json({ message: "Wystąpił błąd serwera", error: errorMessage });
});

const storage = multer.memoryStorage(); // Przechowujemy plik w pamięci

// // Tymczasowe przechowywanie plików
// const storage = multer.diskStorage({
//   destination: "uploads/",
//   filename: (req, file, cb) => {
//     cb(null, uuidv4() + path.extname(file.originalname));
//   },
// });

const upload = multer({ storage });

const uploadToS3 = async (file, userId) => {
  // Dodanie prefixu z ID użytkownika do ścieżki pliku dla łatwiejszego grupowania i bezpieczeństwa
  const prefix = userId ? `users/${userId}/` : "";
  const key = `${prefix}${uuidv4()}${path.extname(file.originalname)}`;

  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: "public-read",
    Metadata: {
      "original-name": encodeURIComponent(file.originalname),
      "upload-date": new Date().toISOString(),
    },
  };

  const command = new PutObjectCommand(params);
  await s3Client.send(command);

  return {
    Key: key,
    Location: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
    originalName: file.originalname,
    size: file.size,
    contentType: file.mimetype,
  };
};

const deleteFromS3 = async (fileKey) => {
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: fileKey,
  };

  const command = new DeleteObjectCommand(params);
  return s3Client.send(command);
};

// Listowanie plików z S3 dla konkretnego użytkownika
const listUserFiles = async (userId) => {
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Prefix: `users/${userId}/`,
    MaxKeys: 1000,
  };

  const command = new ListObjectsV2Command(params);
  const data = await s3Client.send(command);

  if (!data.Contents) return [];

  return data.Contents.map((item) => {
    const urlPath = encodeURIComponent(item.Key).replace(/%2F/g, "/");
    return {
      key: item.Key,
      size: item.Size,
      lastModified: item.LastModified,
      url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${urlPath}`,
    };
  });
};

// Middleware do uwierzytelniania
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ message: "Brak tokenu uwierzytelniającego" });
  }

  try {
    // Weryfikacja tokenu w Cognito
    const command = new GetUserCommand({
      AccessToken: token,
    });

    const userData = await cognitoClient.send(command);

    // Wyciągnięcie informacji o użytkowniku
    const userAttributes = {};
    userData.UserAttributes.forEach((attr) => {
      userAttributes[attr.Name] = attr.Value;
    });

    // Sprawdzenie, czy użytkownik istnieje w bazie danych
    let user = await User.findOne({ where: { email: userAttributes["email"] } });

    if (!user) {
      // Jeśli nie istnieje, utworzenie nowego rekordu
      user = await User.create({
        email: userAttributes["email"],
        cognitoId: userData.Username,
        firstName: userAttributes["given_name"] || "",
        lastName: userAttributes["family_name"] || "",
      });
    }

    // Dodanie informacji o użytkowniku do obiektu request
    req.user = {
      id: user.id,
      email: user.email,
      cognitoId: user.cognitoId,
    };

    next();
  } catch (error) {
    return res.status(403).json({ message: "Token nieprawidłowy lub wygasł", error: error.message });
  }
};

// Endpointy do uwierzytelniania

// Rejestracja użytkownika
app.post("/auth/register", async (req, res) => {
  const { email, password, firstName, lastName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email i hasło są wymagane" });
  }

  try {
    const command = new SignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "given_name", Value: firstName || "" },
        { Name: "family_name", Value: lastName || "" },
      ],
    });

    const response = await cognitoClient.send(command);

    // Zapisanie podstawowych informacji o użytkowniku w bazie danych
    await User.create({
      email,
      cognitoId: response.UserSub,
      firstName: firstName || null,
      lastName: lastName || null,
    });

    res.status(201).json({
      message: "Użytkownik zarejestrowany. Sprawdź email, aby potwierdzić konto.",
      userId: response.UserSub,
    });
  } catch (error) {
    res.status(400).json({ message: "Błąd podczas rejestracji", error: error.message });
  }
});

// Potwierdzenie rejestracji
app.post("/auth/confirm", async (req, res) => {
  const { email, confirmationCode } = req.body;

  try {
    const command = new ConfirmSignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: confirmationCode,
    });

    await cognitoClient.send(command);
    res.json({ message: "Konto zostało potwierdzone. Możesz się teraz zalogować." });
  } catch (error) {
    res.status(400).json({ message: "Błąd podczas potwierdzania konta", error: error.message });
  }
});

// Logowanie użytkownika
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });

    const response = await cognitoClient.send(command);

    // Znalezienie lub utworzenie użytkownika w lokalnej bazie danych
    const getUserCommand = new GetUserCommand({
      AccessToken: response.AuthenticationResult.AccessToken,
    });

    const userData = await cognitoClient.send(getUserCommand);

    const userAttributes = {};
    userData.UserAttributes.forEach((attr) => {
      userAttributes[attr.Name] = attr.Value;
    });

    // Sprawdzenie czy użytkownik istnieje w bazie
    let user = await User.findOne({ where: { email: userAttributes["email"] } });

    if (!user) {
      user = await User.create({
        email: userAttributes["email"],
        cognitoId: userData.Username,
        firstName: userAttributes["given_name"] || null,
        lastName: userAttributes["family_name"] || null,
      });
    }

    res.json({
      message: "Zalogowano pomyślnie",
      tokens: {
        idToken: response.AuthenticationResult.IdToken,
        accessToken: response.AuthenticationResult.AccessToken,
        refreshToken: response.AuthenticationResult.RefreshToken,
        expiresIn: response.AuthenticationResult.ExpiresIn,
      },
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (error) {
    res.status(401).json({ message: "Nieprawidłowe dane logowania", error: error.message });
  }
});

// Reset hasła - żądanie
app.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    const command = new ForgotPasswordCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
    });

    await cognitoClient.send(command);
    res.json({ message: "Kod do resetowania hasła został wysłany na podany adres email" });
  } catch (error) {
    res.status(400).json({ message: "Wystąpił błąd", error: error.message });
  }
});

// Reset hasła - potwierdzenie
app.post("/auth/reset-password", async (req, res) => {
  const { email, confirmationCode, newPassword } = req.body;

  try {
    const command = new ConfirmForgotPasswordCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: confirmationCode,
      Password: newPassword,
    });

    await cognitoClient.send(command);
    res.json({ message: "Hasło zostało zmienione. Możesz się teraz zalogować." });
  } catch (error) {
    res.status(400).json({ message: "Wystąpił błąd", error: error.message });
  }
});

// Pobieranie profilu użytkownika
app.get("/auth/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "Użytkownik nie znaleziony" });
    }

    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    });
  } catch (error) {
    res.status(500).json({ message: "Wystąpił błąd", error: error.message });
  }
});

// Pobieranie wszystkich notatek dla zalogowanego użytkownika
app.get("/notes", authenticateToken, async (req, res) => {
  const notes = await Note.findAll({ where: { userId: req.user.id } });
  res.json(notes);
});

// Tworzenie nowej notatki
app.post("/notes", authenticateToken, async (req, res) => {
  const { title, content } = req.body;
  const newNote = await Note.create({
    title,
    content,
    userId: req.user.id,
  });
  res.status(201).json(newNote);
});

// Pobieranie jednej notatki
app.get("/notes/:id", authenticateToken, async (req, res) => {
  const note = await Note.findOne({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!note) return res.status(404).json({ message: "Notatka nie znaleziona" });
  res.json(note);
});

// Edytowanie notatki
app.put("/notes/:id", authenticateToken, async (req, res) => {
  const note = await Note.findOne({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!note) return res.status(404).json({ message: "Notatka nie znaleziona" });

  const { title, content } = req.body;
  note.title = title || note.title;
  note.content = content || note.content;
  await note.save();
  res.json(note);
});

// Usuwanie notatki
app.delete("/notes/:id", authenticateToken, async (req, res) => {
  const deleted = await Note.destroy({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!deleted) return res.status(404).json({ message: "Notatka nie znaleziona" });
  res.json({ message: "Notatka usunięta" });
});

// Upload plików
app.post("/files/upload", authenticateToken, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Plik nie został przesłany" });

  try {
    const data = await uploadToS3(req.file, req.user.id);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: "Wystąpił błąd podczas przesyłania pliku", error });
  }
});

// Listowanie wszystkich plików zalogowanego użytkownika
app.get("/files", authenticateToken, async (req, res) => {
  try {
    const files = await listUserFiles(req.user.id);
    res.json(files);
  } catch (error) {
    res.status(500).json({ message: "Wystąpił błąd podczas listowania plików", error });
  }
});

// Usuwanie pliku
app.delete("/files/:key", authenticateToken, async (req, res) => {
  // Pobieramy zakodowany klucz z parametru URL
  const key = decodeURIComponent(req.params.key);

  // Sprawdzamy, czy plik należy do tego użytkownika (sprawdzając prefix)
  const userPrefix = `users/${req.user.id}/`;

  if (!key.startsWith(userPrefix)) {
    return res.status(403).json({ message: "Brak uprawnień do usunięcia tego pliku" });
  }

  try {
    await deleteFromS3(key);
    res.json({ message: "Plik został usunięty" });
  } catch (error) {
    res.status(500).json({ message: "Wystąpił błąd podczas usuwania pliku", error });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);

  // // Logujemy start aplikacji
  // logToCloudWatch({
  //   message: `Application started on port ${port}`,
  //   level: "INFO",
  // });

  // Wysyłamy metrykę o starcie aplikacji
  sendMetricToCloudWatch("ApplicationStart", 1, "Count", {});
});

// Obsługa zamknięcia aplikacji
process.on("SIGTERM", async () => {
  console.log("Application shutting down...");

  // Logujemy wyłączenie aplikacji
  await logToCloudWatch({
    message: "Application shutting down",
    level: "INFO",
  });

  process.exit(0);
});
